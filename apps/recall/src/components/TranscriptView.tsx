/**
 * Renders a word-timestamped transcript as clickable ~sentence spans
 * (Task 11): the video page's click-to-seek transcript panel. Words are
 * grouped into a span when a word's own text ends with `.`/`?`/`!`, OR when
 * the gap between it and the next word's start exceeds `GAP_THRESHOLD_SEC`
 * (ASR output sometimes drops terminal punctuation, so a long pause is
 * treated as a sentence boundary too) -- whichever comes first. Every span
 * is rendered as one clickable element; clicking it calls
 * `onSeek(span.start)`.
 *
 * `activeSec` highlights whichever span currently contains it
 * (`span.start <= activeSec < span.end`, half-open so a boundary second
 * belongs to the NEXT span, not the one that just ended). The PUBLIC video
 * page has no live playhead feed (the plain `youtube.com/embed` iframe
 * carries no JS API unless `enablejsapi=1` is wired up), so `Video.tsx`
 * only ever passes the last second the visitor explicitly seeked to -- see
 * that file for the limitation. Post-v1: wire the YouTube iframe API for
 * live playhead tracking. (The ADMIN video page's transcript panel doesn't
 * have this limitation -- it seeks a real `<video>` element and tracks
 * genuine `timeupdate` events, see `AdminVideo.tsx`.)
 */

const GAP_THRESHOLD_SEC = 1.5
const TERMINAL_PUNCTUATION_RE = /[.?!]$/

export type TranscriptWord = { text: string; start: number; end: number }

type TranscriptSpan = { start: number; end: number; text: string }

function groupIntoSpans(words: TranscriptWord[]): TranscriptSpan[] {
  const spans: TranscriptSpan[] = []
  let current: TranscriptWord[] = []

  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    current.push(word)

    const endsSentence = TERMINAL_PUNCTUATION_RE.test(word.text.trim())
    const next = words[i + 1]
    const bigGap = next !== undefined && next.start - word.end > GAP_THRESHOLD_SEC
    const isLastWord = next === undefined

    if (endsSentence || bigGap || isLastWord) {
      spans.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text: current.map((w) => w.text).join(' '),
      })
      current = []
    }
  }

  return spans
}

type TranscriptViewProps = {
  words: TranscriptWord[]
  onSeek: (sec: number) => void
  activeSec?: number
}

export function TranscriptView({ words, onSeek, activeSec }: TranscriptViewProps) {
  const spans = groupIntoSpans(words)

  return (
    <div className="space-y-1 text-slate-700 dark:text-slate-300">
      {spans.map((span, i) => {
        const isActive = activeSec !== undefined && span.start <= activeSec && activeSec < span.end
        return (
          <button
            key={i}
            type="button"
            data-testid="transcript-span"
            data-active={isActive}
            onClick={() => onSeek(span.start)}
            className={
              'mr-1 inline rounded px-1 py-0.5 text-left text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 ' +
              (isActive
                ? 'bg-amber-200 text-slate-900 dark:bg-amber-500/30 dark:text-slate-100'
                : '')
            }
          >
            {span.text}
          </button>
        )
      })}
    </div>
  )
}
