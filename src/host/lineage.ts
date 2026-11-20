export function sessionChain(parentOf: ReadonlyMap<string, string>, sessionId: string): readonly string[] {
  const chain = [sessionId]
  const seen = new Set([sessionId])
  let cursor = sessionId
  for (;;) {
    const parent = parentOf.get(cursor)
    if (parent === undefined || seen.has(parent)) return chain
    seen.add(parent)
    chain.unshift(parent)
    cursor = parent
  }
}

export function mergeSessionStances<T>(
  maps: readonly (Readonly<Record<string, T>> | undefined)[],
): Record<string, T> {
  const merged: Record<string, T> = {}
  for (const map of maps) {
    if (map !== undefined) Object.assign(merged, map)
  }
  return merged
}
