/**
 * Diarization speaker labels (story 10a/10e). Labels are per-video (WhisperX
 * diarizes each file on its own). With the cut-first pivot (ADR-0003) the whole
 * cast/voice mapping is gone — labels are display-only now (transcript preview).
 */
import type { TWord } from './transcriptGrid'

/** Distinct speaker labels in `words`, in first-seen order; undefined dropped. */
export function uniqueSpeakers(words: TWord[]): string[] {
  const seen: string[] = []
  for (const w of words) {
    const s = w.speaker
    if (s && !seen.includes(s)) seen.push(s)
  }
  return seen
}
