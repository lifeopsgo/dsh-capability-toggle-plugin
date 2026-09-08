import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

import { attributeCall } from './inventory.ts'

export function applyCallStats(
  scopedCtx: Context,
  onCall: (id: string) => void,
): () => void {
  return scopedCtx.on('tools/result', (exec) => {
    let id: string | undefined
    try {
      id = typeof exec?.name === 'string' ? attributeCall(exec.name, exec.arguments) : undefined
    } catch {
      return
    }
    if (id === undefined) return
    try {
      onCall(id)
    } catch {
      return
    }
  })
}
