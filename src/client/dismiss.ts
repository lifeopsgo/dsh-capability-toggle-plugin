export function insideAny(target: EventTarget | null, hosts: readonly (Node | null | undefined)[]): boolean {
  if (target === null || typeof target !== 'object') return false
  return hosts.some((host) => host != null && typeof host.contains === 'function' && host.contains(target as Node))
}
