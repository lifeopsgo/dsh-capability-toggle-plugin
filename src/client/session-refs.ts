export interface TriggerRow {
  readonly icon?: unknown
  readonly value?: unknown
}

type Candidates = (...args: unknown[]) => Promise<readonly TriggerRow[]>

interface TriggerSource {
  readonly trigger?: unknown
  readonly name?: unknown
  candidates?: Candidates
}

let resolveService: (() => unknown) | null = null

const original = new WeakMap<object, Candidates>()
const wrapperOf = new WeakMap<object, Candidates>()
const active: TriggerSource[] = []
let holders = 0

function isSessionRow(row: unknown): boolean {
  if (row === null || typeof row !== 'object') return false
  const candidate = row as TriggerRow
  if (candidate.icon === 'session') return true
  if (typeof candidate.value !== 'string') return false
  try {
    const parsed = JSON.parse(candidate.value) as { kind?: unknown } | null
    return parsed !== null && typeof parsed === 'object' && parsed.kind === 'session'
  } catch {
    return false
  }
}

function referenceSources(service: unknown): TriggerSource[] {
  const sources = (service as { live?: { sources?: unknown } } | null)?.live?.sources
  if (!Array.isArray(sources)) return []
  return sources.filter((entry): entry is TriggerSource => {
    if (entry === null || typeof entry !== 'object') return false
    const source = entry as TriggerSource
    return source.trigger === '@' && source.name === 'reference' && typeof source.candidates === 'function'
  })
}

export function disableSessionReferences(service: unknown): () => void {
  holders += 1
  for (const source of referenceSources(service)) {
    if (original.has(source)) continue
    const candidates = source.candidates as Candidates
    const wrapper: Candidates = async (...args) => (await candidates.apply(source, args)).filter(row => !isSessionRow(row))
    original.set(source, candidates)
    wrapperOf.set(source, wrapper)
    source.candidates = wrapper
    active.push(source)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    holders -= 1
    if (holders > 0) return
    for (const source of active.splice(0)) {
      const candidates = original.get(source)
      const wrapper = wrapperOf.get(source)
      if (candidates !== undefined && wrapper !== undefined && source.candidates === wrapper) source.candidates = candidates
      original.delete(source)
      wrapperOf.delete(source)
    }
  }
}

export function bindTriggerService(resolver: () => unknown): void {
  resolveService = resolver
}

export function applySessionRefsPref(disabled: boolean): () => void {
  if (!disabled) return () => {}
  const service = resolveService === null ? undefined : resolveService()
  if (service === undefined) return () => {}
  return disableSessionReferences(service)
}
