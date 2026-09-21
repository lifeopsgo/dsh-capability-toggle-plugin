import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateGuards, guardId } from '../src/host/guards.ts'

const active = new Set([guardId('dangerous-shell')])
const kind = (command: string, shell = 'bash') =>
  evaluateGuards(active, shell, { command })?.decision.kind ?? null

// The gap between a command and its dangerous flag is bounded, and that bound is
// a MEASURED trade. An unbounded gap over a token scan is quadratic in the number
// of command positions: `'rm a '.repeat(n)` cost 183 ms at 60k tokens on the
// token-scan form, and the raw pattern reached 144 s at 128k — a synchronous
// stall on the event loop shared by every agent and the Web GUI, which the
// guards' `try/catch` cannot catch because a slow regex is not a throw. Bounding
// it keeps that flat. The bound still strictly IMPROVES on the released pattern,
// which required the flag immediately after the command name and so matched no
// gap at all: `rm --no-preserve-root -rf /` and `rm -v -rf /` were already misses.
test('dangerous-shell reaches a dangerous operand across the whole gap bound', () => {
  for (const n of [0, 1, 50, 150, 250, 500, 2000, 7900]) {
    assert.equal(kind(`dd ${'x'.repeat(n)} of=/dev/sda`), 'ask', `dd gap ${n}`)
    assert.equal(kind(`dd ${' '.repeat(n)} of=/dev/sda`), 'ask', `dd spaces ${n}`)
  }
  for (const n of [50, 250, 2000]) {
    assert.equal(kind(`Remove-Item${' '.repeat(n)}-Recurse C:\\x`, 'pwsh'), 'ask', `ps gap ${n}`)
  }
  assert.equal(kind(`rm ${' '.repeat(600)} -rf /x`), 'ask')
  assert.equal(kind(`rm ${'x'.repeat(600)} -rf /x`), 'ask')
})

// Anchoring the command to a POSITION was tried and REVERTED. It removed the
// argument false positives below, but it also moved every one of these out of the
// anchor — `find . -exec rm -rf {} +`, `ls | xargs rm -rf`, `sudo -u root rm -rf
// /var`, `/bin/rm -rf /` — turning 34 commands the released pattern flagged into
// silent allows. A bypass in a safety control is strictly worse than an extra
// confirmation prompt, so the unanchored match stays and the noise is accepted.
test('dangerous-shell catches a command reached through any wrapper or executor', () => {
  for (const command of [
    'sh -c "rm -rf /"', "bash -c 'rm -rf /'", 'sudo rm -rf /', 'env rm -rf /',
    'nohup rm -rf /', 'command rm -rf /', 'x=1 rm -rf /', 'FOO=bar rm -rf /tmp',
    'sudo env rm -rf /', 'x; rm -rf /tmp', 'y && rm -f z', 'a | rm -rf b', '(rm -rf /x)',
    'sh -c "dd of=/dev/sda if=/dev/zero"', 'dd bs=1M if=x of=/dev/sda',
    'find . -exec rm -rf {} +', 'find . -print0 | xargs -0 rm -rf', 'ls | xargs rm -rf',
    'sudo -u root rm -rf /var', 'timeout 30 rm -rf /data', 'nice rm -rf /',
    '/bin/rm -rf /', 'env -i rm -rf /', 'sudo -E rm -rf /',
    'for d in /a; do rm -rf "$d"; done', 'if true; then rm -rf x; fi', '! rm -rf x',
  ]) {
    assert.equal(kind(command), 'ask', command)
  }
})

// The accepted cost of that decision: a command name used as an ARGUMENT still
// asks. Kept as a recorded tradeoff rather than a silent surprise — the lexical
// matcher cannot tell `xargs rm` (an executor) from `ls rm` (a file named rm),
// so it errs toward asking.
test('dangerous-shell accepts asking on a command name used as an argument', () => {
  for (const command of ['ls rm foo -rf', 'npm run rm -- -rf', 'tar -czf rm foo -rf']) {
    assert.equal(kind(command), 'ask', command)
  }
  // Plain names and flags of unrelated programs stay clear.
  for (const command of ['rm file.txt', 'npm test', 'ls /dev/sda', 'cat rm.txt', 'docker run --rm --force-rm x']) {
    assert.equal(kind(command), null, command)
  }
})

test('dangerous-shell stays linear on adversarial token and whitespace input', () => {
  const measure = (command: string, shell = 'bash'): number => {
    const t = process.hrtime.bigint()
    evaluateGuards(active, shell, { command })
    return Number(process.hrtime.bigint() - t) / 1e6
  }
  assert.ok(measure(`rm${' '.repeat(64000)}z`) < 500, 'rm whitespace run')
  assert.ok(measure(`dd${' '.repeat(64000)}z`) < 500, 'dd whitespace run')
  assert.ok(measure(`x;rm ${'\r\n'.repeat(40000)} z`, 'pwsh') < 500, 'ps CRLF run')
  assert.ok(measure(`Remove-Item${' '.repeat(64000)}x`, 'pwsh') < 500, 'ps whitespace run')
  // The axis the gap bound exists for: a separator-free run of `rm` positions,
  // where each occurrence scans toward end-of-line. Measured with the bound in
  // place this is linear (10k/20k/40k -> 111/235/476 ms); with the bound removed
  // it is quadratic (471/1772/6908 ms), so a slope check discriminates the two
  // where a single absolute bound does not.
  const n1 = measure(('rm a ').repeat(10000))
  const n2 = measure(('rm a ').repeat(40000))
  assert.ok(n2 < 1500, `rm token flood must be linear, got ${n2.toFixed(0)} ms`)
  assert.ok(n2 / Math.max(n1, 1) < 12, `rm token flood slope must stay linear (4x input -> ${(n2 / Math.max(n1, 1)).toFixed(1)}x)`)
  assert.ok(measure(('git push ').repeat(30000)) < 1500, 'git token flood')
})

// READONLY and the PowerShell patterns have their own reader paths; the previous
// version of this file only exercised dangerous-shell, which is why a quadratic
// in PS_READONLY_WRITE and in READONLY_SHELL_WRITE survived the suite.
test('every shell guard stays linear on its own adversarial input', () => {
  const measure = (guard: string, command: string, shell = 'bash'): number => {
    const t = process.hrtime.bigint()
    evaluateGuards(new Set([guardId(guard)]), shell, { command })
    return Number(process.hrtime.bigint() - t) / 1e6
  }
  const DD = 'd' + 'd'
  // READONLY_SHELL_WRITE: a flood of `dd` tokens used to scan the rest of the
  // line at every position (5059 ms at 192k characters).
  assert.ok(measure('readonly', (DD + ' ').repeat(64000)) < 1500, 'readonly dd flood')
  assert.ok(measure('readonly', (DD + ' ').repeat(64000), 'pwsh') < 1500, 'readonly dd flood pwsh')
  // PS_READONLY_WRITE: adjacent `[ \t]*` groups made an indented plain command
  // quadratic — 13.9 s at 4000 leading spaces, over 185 s at 8000.
  for (const n of [4000, 8000, 32000]) {
    assert.ok(measure('readonly', ' '.repeat(n) + 'zzz', 'pwsh') < 1500, `ps indent ${n}`)
    assert.ok(measure('readonly', ' '.repeat(n) + 'zzz') < 1500, `bash indent ${n}`)
  }
  for (const guard of ['protect-secrets', 'no-destructive-git', 'no-network']) {
    assert.ok(measure(guard, (DD + ' ').repeat(32000)) < 1500, `${guard} dd flood`)
    assert.ok(measure(guard, ' '.repeat(32000) + 'zzz', 'pwsh') < 1500, `${guard} indent`)
  }
})

// A fifth review round found two blockers the tests above could not see: an
// exponential backtrack in PS_ENCODED, and a fail-open where a newline-separated
// command became a silent ALLOW. Both are pinned here.
test('PS_ENCODED cannot be driven into exponential backtracking', () => {
  const network = new Set([guardId('no-network')])
  const measure = (k: number): number => {
    const command = `pwsh ${'-ExecutionPolicy -x '.repeat(k)}zzz`
    const t = process.hrtime.bigint()
    evaluateGuards(network, 'pwsh', { command })
    return Number(process.hrtime.bigint() - t) / 1e6
  }
  // The ambiguity was that an option's VALUE could also parse as the next option,
  // so every position had two parses and the match backtracked exponentially —
  // ~570 bytes reached 15 s through the real evaluateGuards. A disambiguating
  // guard on the value keeps it flat, and a slope check catches a regression that
  // a single absolute bound would miss.
  const small = measure(20)
  const large = measure(28)
  assert.ok(large < 1000, `PS_ENCODED must stay bounded, got ${large.toFixed(0)} ms at k=28`)
  assert.ok(large / Math.max(small, 1) < 20, `growth ${(large / Math.max(small, 1)).toFixed(1)}x must stay flat`)
  // The encoded forms the pattern exists for must still match.
  for (const command of [
    'powershell -ExecutionPolicy Bypass -EncodedCommand ZQBj',
    'pwsh -w hidden -enc AAAA', 'pwsh -w hidden -EncodedCommand AAAA', 'pwsh -e ZQBj',
  ]) {
    assert.equal(evaluateGuards(active, 'pwsh', { command })?.decision.kind, 'ask', command)
  }
  // ...and everyday PowerShell must not be mistaken for an encoded launch.
  for (const command of [
    'pwsh -Command "if ($a -eq 1) { Write-Host hi }"',
    'pwsh -Command "Get-Content x -Encoding UTF8"',
    'pwsh -Command "Write-Host -e hi"', 'pwsh -File script.ps1',
  ]) {
    assert.equal(evaluateGuards(active, 'pwsh', { command }), null, command)
  }
})

test('dangerous commands separated by any whitespace are still caught', () => {
  // The gap class originally excluded `\n`, so `rm\n-rf /` and the CR/CRLF forms
  // became silent ALLOWS where the released version asked — a fail-open in a
  // safety control, introduced while making the gap linear.
  const flag = '-r' + 'f'
  for (const sep of [' ', '\n', '\r\n', '\r', '\t', '   ', '\u000b']) {
    const command = `rm${sep}${flag} /x`
    assert.equal(kind(command), 'ask', JSON.stringify(command))
  }
  assert.equal(kind('rm\nfile.txt'), null)
})

test('the git prefix accepts every whitespace separator the released one did', () => {
  // Separators BETWEEN `git` and `push`. The released pattern used a greedy
  // `[^\n|&;]*` for the flag side, so a newline before `--force` was a miss there
  // too — only the command/verb boundary widened here, and that is what this pins.
  const git = new Set([guardId('no-destructive-git')])
  for (const sep of [' ', '\t', '\n', '\r', '\r\n', '\u000b', '\u00a0']) {
    const command = `git${sep}push --force`
    assert.equal(evaluateGuards(git, 'bash', { command })?.decision.kind, 'ask', JSON.stringify(command))
  }
  assert.equal(evaluateGuards(git, 'bash', { command: 'git status' }), null)
})

test('the readonly dd scan spans a realistic dd argument list', () => {
  // A 300-character window silently lost the deny at 290 filler characters; the
  // released pattern had no window at all, so this was a coverage regression. 2000
  // spans a realistic argument list while keeping the token flood linear.
  const readonly = new Set([guardId('readonly')])
  const DD = 'd' + 'd'
  for (const n of [0, 50, 200, 290, 294, 1000, 1900]) {
    const command = `${DD} if=/dev/zero ${'x'.repeat(n)} of=/dev/sda`
    assert.equal(evaluateGuards(readonly, 'bash', { command })?.decision.kind, 'deny', `filler ${n}`)
  }
})
