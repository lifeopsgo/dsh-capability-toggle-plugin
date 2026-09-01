/**
 * Minimal local type surface for the browser half. The client-side slot and
 * locale services live in platform modules the harness provides at runtime
 * (`@deepseek-ai/dsh-client-ui-slots`, `-primitives`) that are NOT resolvable
 * npm packages in a standalone build, so their prop and service types cannot be
 * imported. This module declares exactly the shapes this plugin reads — nothing
 * more — matching the runtime contract verified against the harness source. The
 * emitted JavaScript is identical to using the framework types; only the
 * compile-time surface is local.
 *
 * @module dsh-capability-toggle-plugin/client/types
 */

import type { CapabilityToggleProjection } from '../shared/types.ts'

/** A locale dictionary: flat key to template string. */
export type LocaleDict = Record<string, string>

/** The translator handed to a slot component bound to a `locale` namespace. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The client root context, narrowed to the two services this plugin injects.
 * `slots.inject` waits for a slot declaration and installs a registration for
 * its lifetime; `locale.register` adds this plugin's dictionaries under a
 * namespace. Both return disposers owned by the caller's fiber.
 */
export interface ClientContext {
  effect(factory: () => (() => void) | void, label?: string): () => void
  readonly slots: {
    inject(key: string, callback: () => (() => void) | void): () => void
    register(spec: SlotSpec, component: SlotComponent): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: { readonly zh: LocaleDict; readonly en: LocaleDict }): () => void
  }
}

/** The registration spec for one slot entry. */
export interface SlotSpec {
  /** The slot key being occupied. */
  readonly name: string
  /** Stable entry id within the slot. */
  readonly id?: string
  /** Ordering hint among sibling entries (lower renders first). */
  readonly order?: number
  /** Locale namespace whose translator is injected as the `t` prop. */
  readonly locale?: string
}

/**
 * The subset of the `conversation.input.left` owner share this plugin reads.
 * The runtime passes the whole conversation snapshot; only `running` and the
 * session identity matter here.
 */
export interface InputZoneProps {
  /** Point-in-time conversation snapshot; re-passed on every input/session change. */
  readonly session: {
    /** The session id — the key the Host HTTP routes address. */
    readonly sessionId: string
    /** Whether the agent is mid-turn; the toggles are read-only while true. */
    readonly running: boolean
  }
  /** The translator bound from the registered `locale` namespace. */
  readonly t: Translate
}

/** A slot component: an ordinary function component over the owner share. */
export type SlotComponent = (props: InputZoneProps) => unknown

/** The set-request body the panel POSTs to the Host. */
export interface SetRequest {
  readonly session: string
  readonly level: 'session' | 'project' | 'global'
  readonly id: string
  readonly state: 'on' | 'off' | 'inherit'
}

/** The set-many (bulk toolbar) request body the panel POSTs to the Host. */
export interface SetManyRequest {
  readonly session: string
  readonly level: 'session' | 'project' | 'global'
  readonly ids: readonly string[]
  readonly state: 'on' | 'off' | 'inherit'
}

/** The Host response carrying a refreshed projection. */
export interface StateResponse {
  readonly projection: CapabilityToggleProjection
}
