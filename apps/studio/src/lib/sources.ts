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

/** A source, reduced to what the Build preview needs to pick a video. */
export type PreviewSourceLike = {
  id: string
  fileName?: string
  sourceUrl?: string | null
}

/**
 * What the Build `<video>` should fall back to for the SELECTED scene while that
 * scene has no cut clip of its own (story 03g) — its OWN source, never the
 * project's legacy top-level `sourceUrl`.
 *
 * Scene `start`/`end` are LOCAL to the scene's source (story 09), and the legacy
 * field mirrors only the FIRST source, so pairing them played the first file's
 * footage under a second-file chapter and seeked it to a local time that means
 * something else there — the picture and the metadata disagreed. Same rule the
 * words / audio / dead-space / filmstrip derivations already follow (#215, #219).
 *
 * `fileName` comes back so the caller can tell whether the in-memory attached
 * File IS this source (and may be shown as a local object URL) or belongs to a
 * different chapter (and must not win over the scene's own source).
 *
 * `fallbackUrl` covers pre-story-09 projects that have scenes but no `sources`.
 */
export function previewSourceFor<T extends PreviewSourceLike>(
  sources: T[],
  scene: { sourceId: string } | null,
  fallbackUrl: string | null,
): { url: string | null; fileName: string | null } {
  const source = scene ? sourceForScene(sources, scene) : null
  if (!source) return { url: fallbackUrl, fileName: null }
  return { url: source.sourceUrl ?? fallbackUrl, fileName: source.fileName ?? null }
}
