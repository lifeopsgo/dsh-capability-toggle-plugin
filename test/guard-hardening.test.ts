import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { evaluateGuards, guardId } from '../src/host/guards.ts'

const check = (guard: string, command: string, shell = 'bash') =>
  evaluateGuards(new Set([guardId(guard)]), shell, { command })?.decision.kind ?? null

test('git prefix options keep destructive and outbound guards in agreement', () => {
  for (const prefix of ['git -C /repo', 'git -C "my repo" -c core.foo=bar', 'git --git-dir=/repo/.git', 'git --work-tree /repo', 'git --no-pager']) {
    for (const shell of ['bash', 'pwsh']) {
      assert.equal(check('no-network', `${prefix} push origin main`, shell), 'ask')
      assert.equal(check('no-destructive-git', `${prefix} push --mirror origin`, shell), 'ask')
      assert.equal(check('no-destructive-git', `${prefix} reset --hard HEAD`, shell), 'ask')
      assert.equal(check('no-destructive-git', `${prefix} status`, shell), null)
      assert.equal(check('no-network', `${prefix} status`, shell), null)
    }
  }
})

test('npm registry values may be separated, quoted, or assigned', () => {
  for (const cmd of ['npm --registry https://example.test publish', 'npm --registry="https://example.test" publish', 'npm --userconfig "my config" --registry=https://example.test publish']) {
    assert.equal(check('no-network', cmd), 'ask', cmd)
  }
  assert.equal(check('no-network', 'npm --registry=https://example.test install'), null)
})

test('search-content patterns are not mistaken for filenames', () => {
  const active = new Set([guardId('protect-secrets')])
  assert.equal(evaluateGuards(active, 'grep', { pattern: '.env', include: '*.md' }), null)
  assert.equal(evaluateGuards(active, 'glob', { pattern: '**/.ENV.local' })?.decision.kind, 'deny')
})

test('dd operands and rm option positions cannot hide existing dangerous operations', () => {
  for (const cmd of ['dd bs=1M of=/dev/disk2 if=x', 'dd of=backup.img if=source.img', 'rm ./dir --recursive', 'rm -v --force ./x']) {
    assert.equal(check('dangerous-shell', cmd), 'ask', cmd)
  }
  assert.equal(check('dangerous-shell', 'rm file.txt'), null)
})

test('encoded PowerShell options retain their exact prefix family with valued options', () => {
  for (const guard of ['dangerous-shell', 'no-network']) {
    for (const cmd of ['powershell -ExecutionPolicy Bypass -enc AAAA', 'pwsh -NoProfile -WindowStyle Hidden -e AAAA']) {
      assert.equal(check(guard, cmd, 'pwsh'), 'ask', cmd)
    }
    for (const cmd of ['pwsh -Command "1 -eq 1"', 'pwsh -Command "Get-Content x -Encoding UTF8"']) {
      assert.equal(check(guard, cmd, 'pwsh'), null, cmd)
    }
  }
})
