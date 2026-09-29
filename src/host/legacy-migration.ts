import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parse } from 'yaml'

import type { OverrideMap } from '../shared/types.ts'
import type { StoredDocument } from './config.ts'

const EMPTY_DOCUMENT: StoredDocument = { global: {}, projects: {}, sessions: {} }

export type LegacyOverridesResult
  = { readonly status: 'available'; readonly value: StoredDocument }
  | { readonly status: 'unavailable' }
  | { readonly status: 'invalid' }

export function mergeLegacyOverrides(
  current: StoredDocument,
  legacy: unknown,
  completed = false,
): StoredDocument {
  if (completed) return current
  const imported = documentOf(legacy) ?? EMPTY_DOCUMENT
  return {
    global: { ...imported.global, ...current.global },
    projects: mergeBuckets(imported.projects, current.projects),
    sessions: mergeBuckets(imported.sessions, current.sessions),
  }
}

export function readLegacyOverridesSyncResult(): LegacyOverridesResult {
  let source: string
  try {
    source = readFileSync(dshHomePath('settings.yaml.imported'), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'unavailable' }
      : { status: 'invalid' }
  }
  return parseLegacyOverridesResult(source)
}

export async function readLegacyOverrides(): Promise<StoredDocument | undefined> {
  let source: string
  try {
    source = await readFile(dshHomePath('settings.yaml.imported'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseLegacyOverrides(source)
}

export function parseLegacyOverridesResult(source: string): LegacyOverridesResult {
  let parsed: unknown
  try {
    parsed = parse(source)
  } catch {
    return { status: 'invalid' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' }
  const legacy = (parsed as Record<string, unknown>)['capability-toggle']
  if (legacy === undefined) return { status: 'unavailable' }
  if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) return { status: 'invalid' }
  const document = documentOf(legacy)
  return document === undefined ? { status: 'invalid' } : { status: 'available', value: document }
}

export function parseLegacyOverrides(source: string): StoredDocument | undefined {
  const result = parseLegacyOverridesResult(source)
  return result.status === 'available' ? result.value : undefined
}

function documentOf(value: unknown): StoredDocument | undefined {
  const record = value as Record<string, unknown>
  const global = record.global === undefined ? {} : overrideMapOf(record.global)
  const projects = record.projects === undefined ? {} : mapOfMaps(record.projects)
  const sessions = record.sessions === undefined ? {} : mapOfMaps(record.sessions)
  if (global === undefined || projects === undefined || sessions === undefined) return undefined
  return { global, projects, sessions }
}

function mergeBuckets(
  legacy: Readonly<Record<string, OverrideMap>>,
  current: Readonly<Record<string, OverrideMap>>,
): Readonly<Record<string, OverrideMap>> {
  const result: Record<string, OverrideMap> = { ...legacy }
  for (const [key, overrides] of Object.entries(current)) {
    result[key] = { ...(legacy[key] ?? {}), ...overrides }
  }
  return result
}

function mapOfMaps(value: unknown): Readonly<Record<string, OverrideMap>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, OverrideMap> = {}
  for (const [key, map] of Object.entries(value)) {
    const parsed = overrideMapOf(map)
    if (parsed !== undefined && Object.keys(parsed).length > 0) result[key] = parsed
  }
  return result
}

function overrideMapOf(value: unknown): OverrideMap | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  const result: Record<string, 'on' | 'off'> = {}
  for (const [key, state] of entries) {
    if (state === 'on' || state === 'off') result[key] = state
  }
  return entries.length > 0 && Object.keys(result).length === 0 ? undefined : result
}
