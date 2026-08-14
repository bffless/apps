/**
 * Reading Studio's fire-and-poll job traffic off the wire. The app polls
 * `GET /api/studio/job?id=…` until a job row reaches a terminal status; the
 * runner watches those responses to learn things the DOM doesn't surface —
 * today, whether transcription actually produced words. A silent recording
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
