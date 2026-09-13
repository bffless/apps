/**
 * Server contact sheets and frame grabs (CE's ffmpeg `frames` op behind
 * /api/video/contact-sheet and /api/video/frames). Pure: coerces job results
 * (shared by MSW and the real rules, per the mock-parity rule) and maps them
 * onto the existing `ContactSheet` shape, so the director, refiner and
 * filmstrip read server sheets exactly as they read the old browser ones.
 */
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
 * Map server sheets onto `ContactSheet`. `displayTimes` are the times the sheet
 * should REPORT, which can differ from the local times sent to CE (prep sheets
 * report global times). They are assigned by position: sheet i holds the next
 * `sheets[i].times.length` entries. `sizes[i]` is the sheet JPEG's natural size;
 * cell geometry is derived from it, or left at 0 when unknown.
 */
export function toContactSheets(
  sheets: ServerSheet[],
  sizes: { width: number; height: number }[],
  displayTimes: number[],
  interval: number,
): ContactSheet[] {
  const gap = SERVER_SHEET_GAP
  let offset = 0
  return sheets.map((s, i) => {
    const times = displayTimes.slice(offset, offset + s.times.length)
    offset += s.times.length
    const width = sizes[i]?.width ?? 0
    const height = sizes[i]?.height ?? 0
    return {
      dataUrl: '',
      url: s.url,
      width,
      height,
      cols: s.cols,
      rows: s.rows,
      cellWidth: width > 0 ? (width - (s.cols + 1) * gap) / s.cols : 0,
      cellHeight: height > 0 ? (height - (s.rows + 1) * gap) / s.rows : 0,
      gap,
      count: times.length,
      times,
      interval,
      bytes: s.bytes,
      index: i,
      total: sheets.length,
    }
  })
}

/** Number sheets gathered from several jobs as one set ("Sheet 2 of 7"). */
export function restampSheets(sheets: ContactSheet[]): ContactSheet[] {
  return sheets.map((s, i) => ({ ...s, index: i, total: sheets.length }))
}
