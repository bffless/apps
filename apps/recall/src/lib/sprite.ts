/**
 * Contact-sheet sprite crop math (PR-feedback-2, reworked multi-sheet-aware
 * in PR-feedback-6). Given a video's sheet metadata and a moment's
 * timestamp, pick the nearest tile — wherever it lives — and compute the
 * CSS `background-position`/`background-size` that crops it out of ITS
 * sheet image at a given display width.
 *
 * Two metadata shapes coexist, since regenerating an already-published
 * video's sheet isn't automatic:
 *   - **v1** (PR-feedback-2, single sheet): `{ cols, rows, tileW, tileH,
 *     tiles: [{t}] }` — no `sheets` array; every tile lives on ONE image,
 *     the record's own `sheet_path`/the search response's `sheetUrl`.
 *   - **v2** (PR-feedback-6, multi-sheet, dense capture): `{ v: 2, cols,
 *     rows, tileW, tileH, sheets: [{ url, tiles: [{t}] }, ...] }` — each
 *     sheet carries its OWN url, so a caller never needs a separate
 *     manifest to know which image a given tile crops from.
 * `normalizeSheets` folds both into one `{ url, tiles }[]` shape (v1 becomes
 * a single-entry list using the caller-supplied fallback URL); everything
 * else in this module works off that normalized form.
 *
 * Pure + unit-tested on purpose (the load-bearing part, per the brief) —
 * `MomentChip` / the admin Frames grid just call these and merge the result
 * with `backgroundImage: url(<the returned url>)`.
 */

export type SheetGrid = {
  cols: number
  rows: number
  tileW: number
  tileH: number
}

/** v1: a single implicit sheet, `tiles` at the top level. */
export type SheetMetaV1 = SheetGrid & { tiles: { t: number }[] }

/** v2: one or more explicit sheets, each with its own url + tiles. */
export type SheetMetaV2 = SheetGrid & {
  v: 2
  sheets: { url: string; tiles: { t: number }[] }[]
}

export type SheetMeta = SheetMetaV1 | SheetMetaV2

export function isSheetMetaV2(meta: SheetMeta): meta is SheetMetaV2 {
  return (meta as SheetMetaV2).v === 2
}

/** One normalized sheet: its url (nullable — a v1 sheet with no fallback
 * given) and its own tiles. */
export type NormalizedSheet = { url: string | null; tiles: { t: number }[] }

/**
 * Fold v1/v2 metadata into a uniform `{ url, tiles }[]` list. A v1 shape
 * becomes exactly one entry, using `fallbackUrl` (the caller's own
 * `sheetUrl`/`sheet_path` — v1 meta carries no url of its own).
 */
export function normalizeSheets(meta: SheetMeta, fallbackUrl: string | null = null): NormalizedSheet[] {
  if (isSheetMetaV2(meta)) {
    return meta.sheets.map((s) => ({ url: s.url, tiles: s.tiles }))
  }
  return [{ url: fallbackUrl, tiles: meta.tiles }]
}

export type NearestTile = { sheetIndex: number; tileIndex: number; url: string | null }

/**
 * The tile (wherever it lives, across every sheet) whose timestamp is
 * closest to `t`. Ties resolve to the earlier tile (scanning low-to-high,
 * `<` not `<=`) — sheets in order, tiles within a sheet in order. Returns
 * `null` for missing/empty metadata.
 */
export function nearestTile(
  meta: SheetMeta | null | undefined,
  t: number,
  fallbackUrl: string | null = null,
): NearestTile | null {
  if (!meta) return null
  const sheets = normalizeSheets(meta, fallbackUrl)

  let best: NearestTile | null = null
  let bestDiff = Infinity
  for (let si = 0; si < sheets.length; si++) {
    const tiles = sheets[si].tiles
    for (let ti = 0; ti < tiles.length; ti++) {
      const diff = Math.abs((tiles[ti]?.t ?? 0) - t)
      if (diff < bestDiff) {
        bestDiff = diff
        best = { sheetIndex: si, tileIndex: ti, url: sheets[si].url }
      }
    }
  }
  return best
}

/**
 * CSS background geometry to display tile `tileIndex` (an index WITHIN its
 * own sheet — e.g. `nearestTile(...).tileIndex`) of a `meta`-described
 * sprite sheet at `displayW` px wide (height follows the tile's own aspect
 * ratio). `cols`/`rows`/`tileW`/`tileH` are shared across every sheet in v2,
 * so this needs no sheet index — the grid geometry is the same regardless of
 * which sheet image `tileIndex` is cropped from. Does NOT set
 * `backgroundImage` — callers merge that in with the relevant sheet's URL.
 * Returns `null` for an out-of-range index or a non-positive
 * `displayW`/tile size, so a caller can fall back to no-sprite rendering.
 */
export function spriteStyle(
  meta: SheetGrid,
  tileIndex: number,
  displayW: number,
): { width: number; height: number; backgroundSize: string; backgroundPosition: string } | null {
  if (!meta || meta.cols <= 0 || meta.rows <= 0 || meta.tileW <= 0 || meta.tileH <= 0) return null
  if (tileIndex < 0 || displayW <= 0) return null

  const scale = displayW / meta.tileW
  const displayH = meta.tileH * scale
  const sheetW = meta.cols * meta.tileW * scale
  const sheetH = meta.rows * meta.tileH * scale

  const col = tileIndex % meta.cols
  const row = Math.floor(tileIndex / meta.cols)
  const bgX = -(col * displayW)
  const bgY = -(row * displayH)

  return {
    width: displayW,
    height: displayH,
    backgroundSize: `${sheetW}px ${sheetH}px`,
    backgroundPosition: `${bgX}px ${bgY}px`,
  }
}
