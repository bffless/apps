import { useMemo } from 'react'
import { formatClock } from '../../lib/transcriptGrid'
import { uniqueSpeakers } from '../../lib/speakers'
import { paragraphs } from '../../lib/transcriptText'
import type { TranscriptWord } from '../../store/studioSlice'

type Props = {
  words: TranscriptWord[]
  /** Seconds per timestamped paragraph. Keep it coarse — this is a "yes, I have
   *  the transcript" read, not the time grid. */
  chunkSeconds?: number
  /** Turn a diarization label (e.g. `SPEAKER_00`) into a display name. Defaults to
   *  the RAW label so it matches the assignment grid; the page passes a cast-name
   *  resolver so a speaker reads as the person's name once they've been mapped. */
  speakerName?: (label: string) => string
  /** Header label — defaults to "Transcript"; the Export page reuses this block
   *  for the final "Script". */
  label?: string
}

/**
 * A plain, scrollable read of the transcript — light timestamps down the left,
 * the words flowing on the right. Just enough to confirm "yes, it's
 * transcribed" without the full time-grid machinery (that lives in the build
 * step now). When diarization found more than one speaker, each turn is labelled
 * (single-speaker clips stay label-free — same "invisible until it matters"
 * philosophy as the cast step).
 */
export function TranscriptText({
  words,
  chunkSeconds = 15,
  speakerName = (label) => label,
  label = 'Transcript',
}: Props) {
  const rows = useMemo(() => paragraphs(words, chunkSeconds), [words, chunkSeconds])
  const showSpeakers = useMemo(() => uniqueSpeakers(words).length > 1, [words])

  return (
    <div className="border rule bg-paper">
      <div className="flex items-baseline justify-between border-b rule px-5 py-3">
        <p className="meta-label">{label}</p>
        <p className="font-mono text-[12px] text-ink-mute">
          {words.length.toLocaleString()} words
        </p>
      </div>

      <div className="max-h-[20rem] overflow-y-auto px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-[13px] text-ink-mute">No words yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((r, i) => (
              <p key={i} className="flex gap-3 text-[14px] leading-relaxed text-ink">
                <span className="select-none pt-0.5 font-mono text-[11px] text-ink-faint">
                  {formatClock(r.start)}
                </span>
                <span>
                  {showSpeakers && r.speaker && (
                    <span className="mr-1.5 font-mono text-[11px] font-medium text-ink-mute">
                      {speakerName(r.speaker)}:
                    </span>
                  )}
                  {r.text}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
