/**
 * Pure helpers for the read-only transcript preview (`TranscriptText`): bucket
 * words into coarse, timestamped paragraphs and turn diarization labels into
 * friendly names. Kept out of the component file so it stays unit-testable and
 * satisfies react-refresh's "components only" export rule.
 */
import type { TranscriptWord } from '../store/studioSlice'

/** One read-paragraph: a timestamp, an optional speaker, and the words. */
export type TranscriptRow = { start: number; speaker?: string; text: string }

/**
 * Bucket words into coarse, timestamped paragraphs so the transcript reads. A new
 * paragraph starts when the `chunkSeconds` window rolls over OR the diarized
 * `speaker` changes — so a two-person clip reads as alternating turns. The row's
 * `start` is the real first-word time (not the bucket), so turns mid-window keep an
 * accurate timestamp.
 */
export function paragraphs(words: TranscriptWord[], chunkSeconds: number): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let lastBucket = -Infinity
  let lastSpeaker: string | undefined
  for (const word of words) {
    const bucket = Math.floor(word.start / chunkSeconds)
    if (rows.length && bucket === lastBucket && word.speaker === lastSpeaker) {
      rows[rows.length - 1].text += ` ${word.text}`
    } else {
      rows.push({ start: word.start, speaker: word.speaker, text: word.text })
      lastBucket = bucket
      lastSpeaker = word.speaker
    }
  }
  return rows
}
