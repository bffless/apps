/**
 * `render: transcript` (02): a list of `{ text, start, end, speaker? }`
 * segments, each a clickable stamp that seeks the nearest video/audio player
 * (`MediaSeekContext`) rather than a static timestamp label.
 *
 * A value that does not match the shape — not an array, or an item missing a
 * string `text` or a numeric `start` — falls back to `JsonTree` inside the
 * same wrapper, the same "still show something, honestly" rule every other
 * malformed-value fallback in this directory follows.
 */
import { useMediaSeek } from '../MediaSeekContext'
import { JsonTree } from '../JsonTree'

interface Segment {
  text: string
  start: number
  end?: number
  speaker?: string
}

function isSegment(item: unknown): item is Segment {
  if (typeof item !== 'object' || item === null) return false
  const v = item as Record<string, unknown>
  return typeof v.text === 'string' && typeof v.start === 'number'
}

function isTranscript(value: unknown): value is Segment[] {
  return Array.isArray(value) && value.every(isSegment)
}

/** `0:00`, `1:05` — minutes unpadded, seconds zero-padded to two digits. */
function stamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function TranscriptView({ value }: { value: unknown }) {
  const { seek } = useMediaSeek()

  if (!isTranscript(value)) {
    return (
      <div className="renderer-transcript" data-testid="renderer" data-render="transcript">
        <JsonTree value={value} />
      </div>
    )
  }

  return (
    <div className="renderer-transcript" data-testid="renderer" data-render="transcript">
      {value.map((segment, i) => (
        <button
          type="button"
          className="transcript-segment"
          key={i}
          onClick={() => seek(segment.start)}
        >
          {`[${stamp(segment.start)}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`}
        </button>
      ))}
    </div>
  )
}
