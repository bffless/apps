/**
 * What a `contentType` says about how a file can be previewed, and how a
 * duration reads — shared by `MediaPreview` (the player), `FileCard` (the
 * Input pane's card) and `kickoff/FileControl` (a file field's rows). Plain
 * functions in their own module so the component file stays fast-refreshable.
 */
export type MediaKind = 'video' | 'audio'

/** `video` / `audio` for a content type `MediaPreview` can play, else `undefined`. */
export function mediaKind(contentType: unknown): MediaKind | undefined {
  if (typeof contentType !== 'string') return undefined
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  return undefined
}

/** `1:05`, `12:30`, `1:02:05` — or `undefined` when the duration is not a finite number. */
export function formatDuration(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}
