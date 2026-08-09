/**
 * Contact-sheet sprite crop math (PR-feedback-2): given a video's sheet
 * metadata (`{ cols, rows, tileW, tileH, tiles: [{ t }] }`, see `frames.ts`
 * for how it's captured) and a search-result moment's timestamp, pick the
 * nearest tile and compute the CSS `background-position`/`background-size`
 * that crops it out of the full sprite sheet at a given display width.
 *
 * Pure + unit-tested on purpose (the load-bearing part, per the brief) —
 * `MomentChip` just calls these and merges the result with
 * `backgroundImage: url(sheetUrl)`.
 */

export type SheetMeta = {
  cols: number
  rows: number
  tileW: number
  tileH: number
  tiles: { t: number }[]
}

/**
 * Index of the tile whose timestamp is closest to `t`. Ties resolve to the
 * earlier tile (the first one found scanning low-to-high, `<` not `<=`).
 * Returns `-1` for an empty/missing tile list.
 */
export function nearestTileIndex(meta: SheetMeta | null | undefined, t: number): number {
  const tiles = meta?.tiles
  if (!Array.isArray(tiles) || tiles.length === 0) return -1

  let best = 0
  let bestDiff = Infinity
  for (let i = 0; i < tiles.length; i++) {
    const diff = Math.abs((tiles[i]?.t ?? 0) - t)
    if (diff < bestDiff) {
      bestDiff = diff
      best = i
    }
  }
  return best
}

/**
 * CSS background geometry to display tile `index` of a `meta`-described
 * sprite sheet at `displayW` px wide (height follows the tile's own aspect
 * ratio). Does NOT set `backgroundImage` — callers merge that in with the
 * sheet's URL. Returns `null` for an out-of-range index or a non-positive
 * `displayW`/tile size, so a caller can fall back to no-sprite rendering.
 */
export function spriteStyle(
  meta: SheetMeta,
  index: number,
  displayW: number,
): { width: number; height: number; backgroundSize: string; backgroundPosition: string } | null {
  if (!meta || meta.cols <= 0 || meta.rows <= 0 || meta.tileW <= 0 || meta.tileH <= 0) return null
  if (index < 0 || displayW <= 0) return null

  const scale = displayW / meta.tileW
  const displayH = meta.tileH * scale
  const sheetW = meta.cols * meta.tileW * scale
  const sheetH = meta.rows * meta.tileH * scale

  const col = index % meta.cols
  const row = Math.floor(index / meta.cols)
  const bgX = -(col * displayW)
  const bgY = -(row * displayH)

  return {
    width: displayW,
    height: displayH,
    backgroundSize: `${sheetW}px ${sheetH}px`,
    backgroundPosition: `${bgX}px ${bgY}px`,
  }
}
