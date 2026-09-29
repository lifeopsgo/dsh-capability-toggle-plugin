import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

import type { LayeredOverrides } from '../shared/types.ts'
import { isDisabled } from '../shared/resolve.ts'
import { attributeCall } from './inventory.ts'

export type CapabilityGateDecision =
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'pass' }

const FAIL_CLOSED_REASON
  = 'Blocked: the capability switch could not be resolved for this call, so it was denied (fail closed).'

export function evaluateCapabilityGate(
  readLayered: () => LayeredOverrides,
  exec: { readonly name?: unknown; readonly arguments?: unknown } | null | undefined,
): CapabilityGateDecision {
  try {
    const id = typeof exec?.name === 'string' ? attributeCall(exec.name, exec.arguments) : undefined
    if (id === undefined) return { action: 'pass' }
    if (isDisabled(readLayered(), id)) {
      return { action: 'deny', reason: `Blocked: capability-toggle has this capability (${id}) switched off.` }
    }
    return { action: 'pass' }
  } catch {
    return { action: 'deny', reason: FAIL_CLOSED_REASON }
  }
}

export function applyCapabilityGate(
  scopedCtx: Context,
  readLayered: () => LayeredOverrides,
): () => void {
  return scopedCtx.on('tools/pre-execute', (exec, next) => {
    const decision = evaluateCapabilityGate(readLayered, exec)
    if (decision.action === 'pass') return next()
    return Promise.resolve({ kind: 'deny', reason: decision.reason } as const)
  }, { prepend: true })
}
