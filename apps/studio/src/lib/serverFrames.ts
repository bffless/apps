/**
 * Server contact sheets and frame grabs (CE's ffmpeg `frames` op behind
 * /api/video/contact-sheet and /api/video/frames). Pure: coerces job results
 * (shared by MSW and the real rules, per the mock-parity rule) and maps them
 * onto the existing `ContactSheet` shape, so the director, refiner and
 * filmstrip read server sheets exactly as they read the old browser ones.
 */
import { cellGeometry } from './filmstrip'
import { clockLabel } from './contactSheet'
import type { ContactSheet } from './frames'

/** Stills per sheet: the contact-sheet rule's `tile.perSheet` literal. */
export const SERVER_SHEET_CELLS = 12
/** Grid width: the rule's `tile.columns` literal. */
export const SERVER_SHEET_COLUMNS = 3
/** CE tiles with `padding=2:margin=2` (ce#706 `buildTileArgs`), the same gap `cellGeometry` assumes. */
export const SERVER_SHEET_GAP = 2

export type ServerSheet = { url: string; times: number[]; cols: number; rows: number; bytes: number }
export type ServerFrame = { time: number; url: string }

function parse(raw: unknown): Record<string, unknown> | null {
  const obj = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function toServerSheets(raw: unknown): ServerSheet[] {
  const list = parse(raw)?.sheets
  const out: ServerSheet[] = []
  for (const item of Array.isArray(list) ? list : []) {
    const r = (item ?? {}) as Record<string, unknown>
    if (typeof r.url !== 'string' || !r.url) continue
    const times = Array.isArray(r.times) ? r.times.filter(finite) : []
    const cols = finite(r.cols) && r.cols > 0 ? r.cols : Math.max(1, Math.min(times.length, SERVER_SHEET_COLUMNS))
    const rows = finite(r.rows) && r.rows > 0 ? r.rows : Math.max(1, Math.ceil(times.length / cols))
    out.push({ url: r.url, times, cols, rows, bytes: finite(r.bytes) ? r.bytes : 0 })
  }
  if (out.length === 0) throw new Error('The contact-sheet job finished without any sheets.')
  return out
}

export function toServerFrames(raw: unknown): ServerFrame[] {
  const list = parse(raw)?.frames
  const out: ServerFrame[] = []
  for (const item of Array.isArray(list) ? list : []) {
    const r = (item ?? {}) as Record<string, unknown>
    if (typeof r.url !== 'string' || !r.url || !finite(r.time)) continue
    out.push({ time: r.time, url: r.url })
  }
  if (out.length === 0) throw new Error('The frame job finished without any frames.')
  return out
}

/** The text CE burns onto each cell: the same clock the browser sheets drew. */
export function sheetLabels(times: number[]): string[] {
  return times.map(clockLabel)
}

/**
 * Map server sheets onto `ContactSheet`. `displayTimeOf` turns a time CE echoed
 * back (the local time sent for that still) into the time the sheet should
 * REPORT (prep sheets report global times). It is matched by time, never by
 * position, so a still CE left out cannot shift the stills after it.
 * `sizes[i]` is the sheet JPEG's natural size; cell geometry is derived from it
 * through `cellGeometry`, or left at 0 when unknown.
 */
export function toContactSheets(
  sheets: ServerSheet[],
  sizes: { width: number; height: number }[],
  displayTimeOf: (t: number) => number,
  interval: number,
): ContactSheet[] {
  return sheets.map((s, i) => {
    const times = s.times.map(displayTimeOf)
    const width = sizes[i]?.width ?? 0
    const height = sizes[i]?.height ?? 0
    // Build base sheet with cellWidth/cellHeight at 0, then derive geometry
    const base: ContactSheet = {
      dataUrl: '',
      url: s.url,
      width,
      height,
      cols: s.cols,
      rows: s.rows,
      cellWidth: 0,
      cellHeight: 0,
      gap: SERVER_SHEET_GAP,
      count: s.times.length,
      times,
      interval,
      bytes: s.bytes,
      index: i,
      total: sheets.length,
    }
    // Derive geometry from the base sheet only when both dimensions are known
    if (width > 0 && height > 0) {
      const { cellWidth, cellHeight, gap } = cellGeometry(base)
      return { ...base, cellWidth, cellHeight, gap }
    }
    return base
  })
}

/** Number sheets gathered from several jobs as one set ("Sheet 2 of 7"). */
export function restampSheets(sheets: ContactSheet[]): ContactSheet[] {
  return sheets.map((s, i) => ({ ...s, index: i, total: sheets.length }))
}
