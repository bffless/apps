/**
 * Pure timeline math for the multi-video project (story 09a). The master
 * director sees all sources stitched into ONE global timeline (video A occupies
 * [0, durA), video B [durA, durA+durB), ...); these helpers convert between that
 * global time and a single source's local time. Stored scenes use LOCAL time +
 * a `sourceId`; the global timeline only exists transiently while building the
 * director request and coercing its response. Order is whatever the caller
 * passes — callers sort `sources` by `order` first.
 */

export type SourceLike = { id: string; duration: number }
export type SourceSpan = { id: string; start: number; end: number }

const dur = (d: unknown): number => (typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0)

/** Total length of all sources, in seconds. */
export function totalDuration(sources: SourceLike[]): number {
  return sources.reduce((sum, s) => sum + dur(s.duration), 0)
}

/** Each source's [start, end) on the global timeline, in input order. */
export function sourceOffsets(sources: SourceLike[]): SourceSpan[] {
  const out: SourceSpan[] = []
  let cursor = 0
  for (const s of sources) {
    const end = cursor + dur(s.duration)
    out.push({ id: s.id, start: cursor, end })
    cursor = end
  }
  return out
}

/**
 * Route a GLOBAL second to its owning source + LOCAL second. Spans are half-open
 * `[start, end)` so a boundary instant belongs to the next source; the very end
 * of the timeline clamps into the last source. Out-of-range clamps to the
 * nearest end. Null when there are no sources.
 */
export function globalToLocal(
  sources: SourceLike[],
  t: number,
): { sourceId: string; localTime: number } | null {
  const spans = sourceOffsets(sources)
  if (spans.length === 0) return null
  const clamped = Math.max(0, Math.min(t, spans[spans.length - 1].end))
  for (const span of spans) {
    if (clamped < span.end) return { sourceId: span.id, localTime: clamped - span.start }
  }
  const last = spans[spans.length - 1]
  return { sourceId: last.id, localTime: last.end - last.start }
}

/** LOCAL second within `sourceId` -> its GLOBAL second. Null if id is unknown. */
export function localToGlobal(
  sources: SourceLike[],
  sourceId: string,
  localTime: number,
): number | null {
  const span = sourceOffsets(sources).find((s) => s.id === sourceId)
  return span ? span.start + localTime : null
}

/** The source a scene belongs to (story 09d), by `sourceId`. Generic over the
 *  source shape so callers can pass the full `VideoSource[]` from the slice or a
 *  lightweight `{id}` list. Null if the id isn't found. */
export function sourceForScene<T extends { id: string }>(
  sources: T[],
  scene: { sourceId: string },
): T | null {
  return sources.find((s) => s.id === scene.sourceId) ?? null
}
