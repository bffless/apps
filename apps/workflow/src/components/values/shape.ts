/**
 * What a recorded value *looks like*, when nothing declared how to draw it
 * (02 "Inferred shapes", apps#450). The JSON tree stays the fallback for any
 * value; this module decides when a friendlier viewer applies first.
 *
 * The harness recognises **shapes**, never subjects: an array of homogeneous
 * flat rows is a table whatever the rows mean; an array of numbers is a list;
 * an object with `path`/`name`/`url` is the harness's own File ref; a long
 * slash-separated string is a storage path. Key names are read only for the
 * one thing a name can say about a *number* — that it is a time in seconds
 * (`start`, `end`, `duration`, …) — and nothing here knows what a scene, a
 * cut or a clip is. An author who needs more says so with `format:` (02).
 *
 * Plain functions in their own module (no React) so the tests can pin the
 * rules and the component files stay fast-refreshable.
 */
import type { FileRef } from '../../lib/runner/types'
import type { ValueDecl } from '../../lib/valueDecl'
import { isFileRef } from './fileRef'
import { BLOCK_TEXT_LENGTH } from './textValue'

/** A table is only inferred up to this many columns — wider rows stay a tree. */
export const TABLE_MAX_COLUMNS = 8
/** Rows shown before the table folds the rest behind "show all". */
export const TABLE_PREVIEW_ROWS = 40
/** Items shown inline before a compact list folds the rest behind "show all". */
export const LIST_PREVIEW = 12
/** Items shown before a `list: true` value folds the rest behind "show all". */
export const LIST_ITEMS_PREVIEW = 24
/** A string is a storage path when it has at least this many `/`-separated segments … */
export const PATH_MIN_SEGMENTS = 3
/** … and is at least this long — a short `a/b/c` reads fine as a chip. */
export const PATH_MIN_LENGTH = 32

/** The tree walk that asks "is anything in here shaped?" stops this deep. */
const SHAPE_DEPTH = 6
/** … and looks at this many children per node — the tree renders no more (`JsonTree`). */
const SHAPE_BREADTH = 200

export type Scalar = string | number | boolean | null

/** A table column as the viewer takes it: the row key, and a header when declared. */
export interface TableColumn {
  key: string
  label?: string
}

export type Shape =
  | { kind: 'file'; ref: FileRef }
  | { kind: 'files'; refs: FileRef[] }
  | { kind: 'table'; columns: TableColumn[]; rows: unknown[] }
  | { kind: 'list'; items: Scalar[] }
  | { kind: 'path'; path: string }

/**
 * A number the way a person reads it: integers as they are, fractions to two
 * decimals with the trailing zeros dropped, and a fraction too small for two
 * decimals to two significant digits rather than a misleading `0`.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || Number.isInteger(n)) return String(n)
  const fixed = n.toFixed(2).replace(/\.?0+$/, '')
  return Number(fixed) === 0 ? n.toPrecision(2) : fixed
}

/** `0:08.5`, `2:05.3`, `1:02:05.3` — a time in seconds as `m:ss.s`; a negative or non-finite one as a plain number. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return formatNumber(seconds)
  const tenths = Math.round(seconds * 10)
  const h = Math.floor(tenths / 36_000)
  const m = Math.floor((tenths % 36_000) / 600)
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, '0')
  return `${h > 0 ? `${h}:` : ''}${h > 0 ? String(m).padStart(2, '0') : m}:${s}`
}

const TIME_WORDS = new Set(['start', 'end', 'duration', 'offset', 'time'])
const SECONDS_WORDS = new Set(['s', 'sec', 'secs', 'seconds'])

/**
 * Whether a key says the number under it is a time in seconds: its last word
 * is `start`/`end`/`duration`/`offset`/`time` (`startTime`, `clip_end`), or a
 * seconds unit after another word (`start_s`, `durationSec`, `seconds`).
 */
export function isTimeKey(key: string): boolean {
  const words = key
    .split(/[_\-\s.]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
  const last = words[words.length - 1]
  if (last === undefined) return false
  if (TIME_WORDS.has(last)) return true
  return last === 'seconds' || (SECONDS_WORDS.has(last) && words.length > 1)
}

/**
 * A storage key rather than a sentence: no whitespace, no scheme, at least
 * `PATH_MIN_SEGMENTS` non-empty segments, at least `PATH_MIN_LENGTH` long.
 * (06's own paths — `workflows/<impl>/<workflow>/runs/<run>/…` — always are.)
 */
export function isStoragePath(text: string): boolean {
  if (text.length < PATH_MIN_LENGTH || /\s/.test(text) || text.includes('://')) return false
  const segments = text.split('/')
  return segments.length >= PATH_MIN_SEGMENTS && segments.every((segment) => segment.length > 0)
}

/** The last segment of a path — what the chip shows; the whole path is on hover. */
export function basename(path: string): string {
  return path.split('/').pop() || path
}

/** A cell-sized value: null, a boolean, a number, or a string that would be a chip. */
export function isScalar(value: unknown): value is Scalar {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true
  return typeof value === 'string' && !value.includes('\n') && value.length <= BLOCK_TEXT_LENGTH
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isFileRef(value)
}

/**
 * Homogeneous flat rows: every item a plain object with the *same* keys (in
 * any order), every value a scalar, and no more than `TABLE_MAX_COLUMNS`
 * keys. Columns follow the first row's key order.
 */
function homogeneousRows(items: unknown[]): TableColumn[] | null {
  const first = items[0]
  if (!isRow(first)) return null
  const columns = Object.keys(first)
  if (columns.length === 0 || columns.length > TABLE_MAX_COLUMNS) return null
  const signature = [...columns].sort().join(' ')
  for (const item of items) {
    if (!isRow(item)) return null
    const keys = Object.keys(item)
    if (keys.length !== columns.length || [...keys].sort().join(' ') !== signature) return null
    if (!keys.every((key) => isScalar(item[key]))) return null
  }
  return columns.map((key) => ({ key }))
}

/** Every key any row has, in first-seen order, for a `format: table` whose rows are ragged. */
function unionColumns(items: unknown[]): TableColumn[] {
  const seen = new Set<string>()
  for (const item of items) if (isRow(item)) for (const key of Object.keys(item)) seen.add(key)
  return [...seen].map((key) => ({ key }))
}

/** `columns: [start, end]` or `[{ key, label? }]` (02) — a bare string is its own key. */
function declaredColumns(columns: unknown): TableColumn[] | null {
  if (!Array.isArray(columns)) return null
  const resolved: TableColumn[] = []
  for (const entry of columns) {
    if (typeof entry === 'string') resolved.push({ key: entry })
    else if (entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string') {
      const { key, label } = entry as { key: string; label?: unknown }
      resolved.push(typeof label === 'string' ? { key, label } : { key })
    }
  }
  return resolved.length > 0 ? resolved : null
}

/**
 * The shape a value has, declared (`format: table|list|path`) or inferred —
 * or `null` when it has none and the tree is the right viewer. Declared
 * formats win, and are lenient (a `format: table` over ragged rows takes the
 * union of their keys); inference is strict, so a value never gets a viewer
 * that would hide part of it.
 */
export function inferShape(value: unknown, decl: Pick<ValueDecl, 'format' | 'columns'> = {}): Shape | null {
  if (typeof value === 'string') {
    return decl.format === 'path' || isStoragePath(value) ? { kind: 'path', path: value } : null
  }
  if (value === null || typeof value !== 'object') return null
  if (isFileRef(value)) return { kind: 'file', ref: value }
  if (!Array.isArray(value) || value.length === 0) return null
  if (value.every(isFileRef)) return { kind: 'files', refs: value }

  if (decl.format === 'table') {
    const columns = declaredColumns(decl.columns) ?? unionColumns(value)
    return columns.length > 0 ? { kind: 'table', columns, rows: value } : null
  }
  if (decl.format === 'list') {
    return value.every(isScalar) ? { kind: 'list', items: value } : null
  }

  const columns = homogeneousRows(value)
  if (columns) return { kind: 'table', columns, rows: value }
  if (
    value.every((item) => typeof item === 'number') ||
    value.every((item) => typeof item === 'string' && isScalar(item))
  ) {
    return { kind: 'list', items: value as Scalar[] }
  }
  return null
}

/**
 * Whether the tree would draw anything but leaves and nodes for this value —
 * the value itself, or something inside it, has a shape. Bounded the way the
 * tree is, so a huge value costs no more to ask than to draw.
 */
export function hasShape(value: unknown, depth = 0): boolean {
  if (inferShape(value)) return true
  if (depth >= SHAPE_DEPTH || value === null || typeof value !== 'object') return false
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
  return children.slice(0, SHAPE_BREADTH).some((child) => hasShape(child, depth + 1))
}
