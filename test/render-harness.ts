/**
 * Renders components.tsx without a DOM: transform the TSX with the repo's own
 * bundler, install a hook dispatcher, then call Panel directly and walk the
 * element tree it returns. Each component invocation gets its own hook scope so
 * a child's useState cannot collide with its parent's.
 *
 * Why walk the element tree instead of mounting it: `react-dom`, `jsdom`, and
 * `@testing-library/react` are all absent from devDependencies, so nothing here can
 * attach this component to a document. Reading the props off the elements React
 * returns is enough for what these tests pin — which control carries `disabled`,
 * and what a handler does when invoked — and it needs no renderer. `userType` and
 * `userClick` supply the one thing the element tree cannot: the browser rule that a
 * disabled control never dispatches a user event, without which a test could call
 * `onChange` straight past the lock and pass while the field is unusable.
 *
 * React 18 exposes the dispatcher through a private internals object that React 19
 * removed. `available` reports whether the hook dispatcher was installed; the
 * sentinel test in ./panel-render.test.ts asserts it, so a React bump fails loudly
 * instead of skipping the render suite green.
 *
 * @module dsh-capability-toggle-plugin/test/render-harness
 */

import { Rolldown } from 'tsdown'
import { writeFileSync, mkdirSync } from 'node:fs'
import React from 'react'

const internals = (React as unknown as {
  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: { ReactCurrentDispatcher?: { current: unknown } }
}).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED

const dispatcherSeat = internals?.ReactCurrentDispatcher

export const available = dispatcherSeat !== undefined

interface Scope { slots: unknown[]; idx: number }
export interface Element { readonly tag: string; readonly props: Record<string, unknown>; readonly path: string }

const scopes = new Map<string, Scope>()
let current: Scope | null = null

function scopeFor(path: string): Scope {
  let scope = scopes.get(path)
  if (scope === undefined) {
    scope = { slots: [], idx: 0 }
    scopes.set(path, scope)
  }
  return scope
}

if (dispatcherSeat !== undefined) {
  dispatcherSeat.current = {
    useState(init: unknown) {
      const scope = current as Scope
      const at = scope.idx++
      if (!(at in scope.slots)) {
        scope.slots[at] = typeof init === 'function' ? (init as () => unknown)() : init
      }
      return [scope.slots[at], (next: unknown) => {
        scope.slots[at] = typeof next === 'function' ? (next as (v: unknown) => unknown)(scope.slots[at]) : next
      }]
    },
    useRef(init: unknown) {
      const scope = current as Scope
      const at = scope.idx++
      if (!(at in scope.slots)) scope.slots[at] = { current: init }
      return scope.slots[at]
    },
    useEffect() {},
    useCallback(fn: unknown) { return fn },
    useMemo(fn: () => unknown) { return fn() },
  }
}

let Panel: ((props: unknown) => unknown) | null = null

async function load(): Promise<(props: unknown) => unknown> {
  if (Panel !== null) return Panel
  mkdirSync(new URL('../.temp/', import.meta.url), { recursive: true })
  // One stable path, overwritten per run: a PID-keyed name leaked a file into
  // .temp on every invocation. The version query below still defeats the ESM
  // import cache, so a rebuild is always picked up.
  const out = new URL('../.temp/panel-render.mjs', import.meta.url)
  const bundle = await Rolldown.rolldown({
    input: new URL('../src/client/components.tsx', import.meta.url).pathname,
    external: ['react', 'react/jsx-runtime'],
  })
  const { output } = await bundle.generate({ format: 'esm' })
  writeFileSync(out, output[0].code)
  const mod = await import(`${out.pathname}?v=${Date.now()}`)
  Panel = mod.Panel as (props: unknown) => unknown
  return Panel
}

function walk(node: unknown, path: string, out: Element[], depth: number): Element[] {
  if (node === null || node === undefined || node === false || depth > 80) return out
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}/${i}`, out, depth + 1))
    return out
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> }
  if (typeof el.type === 'function') {
    const scope = scopeFor(path)
    const outer = current
    current = scope
    scope.idx = 0
    try {
      walk((el.type as (p: unknown) => unknown)(el.props ?? {}), path, out, depth + 1)
    } catch {
      // A child that needs a real renderer (context, portal) is skipped; the
      // search input and the level switches render without either.
    } finally {
      current = outer
    }
    return out
  }
  if (typeof el.type === 'string') {
    const props = (el.props ?? {}) as Record<string, unknown>
    out.push({ tag: el.type, props, path })
    const { children, ...rest } = props
    for (const [key, value] of Object.entries(rest)) {
      if (value !== null && typeof value === 'object' && 'type' in (value as object)) {
        walk(value, `${path}.${key}`, out, depth + 1)
      }
    }
    walk(children, `${path}/children`, out, depth + 1)
  }
  return out
}

export interface Rendered {
  readonly elements: readonly Element[]
  readonly find: (className: string) => Element | undefined
  readonly findAll: (className: string) => readonly Element[]
}

function toRendered(elements: Element[]): Rendered {
  const hasClass = (el: Element, name: string): boolean => {
    const value = el.props.className
    return typeof value === 'string' && value.split(/\s+/).includes(name)
  }
  return {
    elements,
    find: name => elements.find(el => hasClass(el, name)),
    findAll: name => elements.filter(el => hasClass(el, name)),
  }
}

// A real browser suppresses user-initiated events on a disabled form control:
// the change and click handlers never fire. Modelling that here is what makes
// "typing filters the rows" a discriminating test instead of one that passes by
// calling the handler past the lock.
export class DisabledControl extends Error {}

export function userType(el: Element, value: string): void {
  if (el.props.disabled === true) throw new DisabledControl(`cannot type into a disabled ${String(el.props.className)}`)
  const onChange = el.props.onChange
  if (typeof onChange !== 'function') throw new Error('the element takes no onChange')
  ;(onChange as (e: { target: { value: string } }) => void)({ target: { value } })
}

export function userClick(el: Element): void {
  if (el.props.disabled === true) throw new DisabledControl(`cannot click a disabled ${String(el.props.className)}`)
  const onClick = el.props.onClick
  if (typeof onClick !== 'function') throw new Error('the element takes no onClick')
  ;(onClick as () => void)()
}

export async function renderPanel(props: unknown, keepState = false): Promise<Rendered> {
  const render = await load()
  if (!keepState) scopes.clear()
  const root = scopeFor('')
  const outer = current
  current = root
  root.idx = 0
  try {
    return toRendered(walk(render(props), '', [], 0))
  } finally {
    current = outer
  }
}
