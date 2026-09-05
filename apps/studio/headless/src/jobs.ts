/**
 * Reading Studio's fire-and-poll job traffic off the wire. The app polls
 * `GET /api/studio/job?id=…` until a job row reaches a terminal status; the
 * runner watches those responses to learn things the DOM doesn't surface —
 * whether transcription actually produced words, and which ffmpeg executor a
 * server video job ran on and how long it took. A silent recording
 * (muted mic) transcribes to `{text: "", words: []}` with status `done`, the
 * stage badge says "0 words" and the whole pipeline then burns 30 minutes of
 * AI credits building an uncut video no describe/thumbnail/blog step can use.
 */

/** Path fragment of the job-poll endpoint (`studioApi.getStudioJob`). */
export const JOB_POLL_PATH = '/api/studio/job'

/**
 * If `body` is a FINISHED transcribe job row, return how many words it
 * produced (0 = silent/undecodable audio); anything else → null.
 */
export function transcribeWordCount(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const job = body as { kind?: unknown; status?: unknown; result?: unknown }
  if (job.kind !== 'transcribe' || job.status !== 'done') return null
  const words = (job.result as { words?: unknown } | null | undefined)?.words
  return Array.isArray(words) ? words.length : 0
}

/** What a finished server video job tells us about where and how long it ran. */
export type VideoJobStats = {
  /** `video-slice` | `video-extract` | `video-concat` — the job row's `kind`. */
  kind: string
  /** CE executor that ran the op (`local` | `remote`); null on a pre-0.4.31 CE. */
  executor: string | null
  /** Wall-clock ms for the op (`timings.totalMs`); null when the row lacks it. */
  totalMs: number | null
}

/**
 * If `body` is a FINISHED `video-*` job row, return its executor + total ffmpeg
 * time (CE >= 0.4.31 puts them on the row's `result`, apps#605); anything else
 * → null. `executor`/`totalMs` are null (not absent) when the row lacks them.
 */
export function videoJobStats(body: unknown): VideoJobStats | null {
  if (!body || typeof body !== 'object') return null
  const job = body as { kind?: unknown; status?: unknown; result?: unknown }
  if (typeof job.kind !== 'string' || !job.kind.startsWith('video-') || job.status !== 'done') return null
  const result = (job.result && typeof job.result === 'object' ? job.result : {}) as {
    executor?: unknown
    timings?: unknown
  }
  const totalMs = (result.timings as { totalMs?: unknown } | null | undefined)?.totalMs
  return {
    kind: job.kind,
    executor: typeof result.executor === 'string' && result.executor ? result.executor : null,
    totalMs: typeof totalMs === 'number' && Number.isFinite(totalMs) ? totalMs : null,
  }
}

/** `video-slice · remote · 20.8 s` — one progress line per finished video job (`—` for a missing field). */
export function formatVideoJobLine(stats: VideoJobStats): string {
  const secs = stats.totalMs == null ? '—' : `${(stats.totalMs / 1000).toFixed(1)} s`
  return `${stats.kind} · ${stats.executor ?? '—'} · ${secs}`
}
