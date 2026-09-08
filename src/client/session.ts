import type { InputZoneProps } from './types.ts'

export function sessionIdOf(props: InputZoneProps): string {
  const legacy = props.session?.sessionId
  if (typeof legacy === 'string' && legacy !== '') return legacy
  return typeof props.sessionId === 'string' ? props.sessionId : ''
}

export function runningOf(props: InputZoneProps): boolean {
  const legacy = props.session?.running
  if (typeof legacy === 'boolean') return legacy
  if (props.useSession === undefined) return false
  return props.useSession((snapshot) => snapshot.running === true)
}
