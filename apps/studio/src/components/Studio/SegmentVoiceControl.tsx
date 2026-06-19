import { useEffect, useRef } from 'react'
import { useRecorder } from './useRecorder'
import { useClipPlaying } from './clipPlayer'
import { formatTime } from '../../lib/edl'

/** One narration run's voice state + position, for the inline diff-viewer control. */
export type SegmentControl = {
  sceneId: string
  /** Segment index within its scene. */
  index: number
  /** Anchor time (original-video seconds) — places the control on its row. */
  start: number
  /** The run's end — `end - start` is the duration a move preserves (story 03h). */
  end: number
  text: string
  audioUrl?: string
  audioSeconds?: number
  audioSource?: 'ai' | 'recorded' | 'original'
  /** The refiner's voicing suggestion for this run (story 03j). */
  suggestedSource?: 'original' | 'revoice'
  /** This segment is mid-voicing (AI call or record upload). */
  busy: boolean
  /** The segment's default voice label (from its speaker), shown when no override. */
  speakerName?: string
  /** The voice id resolved from the segment's dominant speaker. */
  defaultVoiceId?: string
  /** The producer's override (story 10d); falls back to defaultVoiceId. */
  voiceId?: string
}

type Props = {
  segment: SegmentControl
  /** Whether a narration voice exists (enables the AI option). */
  canAI: boolean
  onGenerateAI: () => void
  onRecord: (blob: Blob) => void
  onPlay: (url: string) => void
  /** Delete this run, reopening its gap (story 03d). */
  onDelete: () => void
  /** Begin a move drag (story 03h): pointer-down on the ⠿ handle, drag over the
   *  grid to re-time the run. Omit to hide the handle. */
  onMoveStart?: () => void
  /** Voice this run with the clip's own audio (story 03j) — rendered only while
   *  the run is unvoiced and the AI suggested 'original'. Omit to hide. */
  onUseOriginal?: () => void
  /** List of voices to offer in the picker (cast + presets). Omit to hide. */
  voiceOptions?: { voiceId: string; label: string }[]
  /** Called when the producer picks a voice from the dropdown. */
  onPickVoice?: (voiceId: string) => void
}

/** How the run was voiced, for the inline label. */
const sourceLabel: Record<NonNullable<SegmentControl['audioSource']>, string> = {
  recorded: 'you',
  ai: 'AI',
  original: 'original',
}

const btn =
  'rounded border border-paper-line px-1.5 py-0.5 text-[11px] text-ink transition-colors hover:bg-paper disabled:opacity-50'

/**
 * Inline, per-segment voice control shown in the diff viewer at each narration
 * run's start row. Two ways to voice a run: **record it yourself** (mic, so it's
 * actually you) or **AI-generate** it in the saved voice. Once voiced, a play
 * button + length + source ("you"/"AI") show, with re-record / re-AI. Kept to one
 * row tall so the two diff panes stay aligned. This row doubles as the run's
 * **drag handle** (story 03h) — chosen so moving never collides with
 * cut-painting, which owns pointer-drags that start on the grid cells.
 */
export function SegmentVoiceControl({ segment, canAI, onGenerateAI, onRecord, onPlay, onDelete, onMoveStart, onUseOriginal, voiceOptions, onPickVoice }: Props) {
  const recorder = useRecorder()
  const submitted = useRef(false)

  // A take is a quick one-shot: as soon as it stops, hand the blob up to upload
  // and reset back to idle (no separate "use this take" step).
  useEffect(() => {
    if (recorder.status === 'recorded' && recorder.blob && !submitted.current) {
      submitted.current = true
      onRecord(recorder.blob)
      recorder.reset()
    }
    if (recorder.status === 'idle') submitted.current = false
  }, [recorder.status, recorder.blob, onRecord, recorder])

  const { audioUrl, audioSeconds, audioSource, busy } = segment
  const playing = useClipPlaying(audioUrl)

  return (
    <div className="flex h-9 items-center gap-2 overflow-hidden border-t border-paper-line/60 bg-paper-deep/40 px-2 text-[11px]">
      {onMoveStart && (
        <span
          role="button"
          aria-label="Drag to move this run"
          title="Drag up or down over the grid to re-time this run"
          onPointerDown={(e) => {
            e.preventDefault() // no text selection while dragging
            onMoveStart()
          }}
          className="-mx-1 cursor-grab select-none px-1 text-[13px] leading-none text-ink-faint transition-colors hover:text-ink active:cursor-grabbing"
        >
          ⠿
        </span>
      )}
      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">voice</span>

      {recorder.status === 'recording' ? (
        <>
          <span className="flex items-center gap-1 font-mono text-terracotta-ink">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-terracotta-ink" />
            {formatTime(recorder.elapsed)}
          </span>
          <button type="button" className={btn} onClick={recorder.stop}>
            ■ Stop
          </button>
        </>
      ) : busy ? (
        <span className="text-ink-mute">Saving…</span>
      ) : (
        <>
          {audioUrl && (
            <>
              <button
                type="button"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-terracotta text-paper transition-colors hover:bg-terracotta-hover"
                onClick={() => onPlay(audioUrl)}
                title={playing ? 'Pause this run' : 'Play this run'}
                aria-label={playing ? 'Pause this run' : 'Play this run'}
              >
                {playing ? (
                  <svg viewBox="0 0 12 12" className="h-3 w-3 fill-current" aria-hidden="true">
                    <path d="M1.5 0.5h3.2v11H1.5zM7.3 0.5h3.2v11H7.3z" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 12 12"
                    className="ml-0.5 h-3 w-3 fill-current"
                    aria-hidden="true"
                  >
                    <path d="M1.5 0 11.5 6 1.5 12z" />
                  </svg>
                )}
              </button>
              <span className="font-mono text-ink-mute">
                {(audioSeconds ?? 0).toFixed(1)}s · {audioSource ? sourceLabel[audioSource] : 'AI'}
              </span>
            </>
          )}
          {!audioUrl && segment.suggestedSource === 'original' && onUseOriginal && (
            <button
              type="button"
              className={btn}
              onClick={onUseOriginal}
              title="The AI suggests keeping your own audio here — slice it straight from the clip"
              aria-label="Use original audio for this run"
            >
              ◉ Use original
            </button>
          )}
          <button type="button" className={btn} onClick={() => void recorder.start()}>
            ● {audioUrl ? 'Re-record' : 'Record'}
          </button>
          <button
            type="button"
            className={btn}
            disabled={!canAI}
            onClick={onGenerateAI}
            title={canAI ? undefined : 'Choose a narration voice in prep first'}
          >
            ✨ {audioUrl ? 'Re-AI' : 'AI'}
          </button>
          {voiceOptions && voiceOptions.length > 0 && (
            <select
              className="rounded border border-paper-line bg-paper px-1 py-0.5 text-[11px] text-ink transition-colors"
              value={segment.voiceId ?? segment.defaultVoiceId ?? ''}
              onChange={(e) => onPickVoice?.(e.target.value)}
              title={segment.speakerName ? `Speaker: ${segment.speakerName}` : 'Voice'}
            >
              {!segment.defaultVoiceId && <option value="">choose voice…</option>}
              {voiceOptions.map((o) => (
                <option key={o.voiceId} value={o.voiceId}>{o.label}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={`${btn} ml-auto`}
            onClick={onDelete}
            title="Delete this run (reopens the gap)"
            aria-label="Delete this run"
          >
            ✕
          </button>
        </>
      )}

      {recorder.error && (
        <span className="truncate font-mono text-terracotta-ink">{recorder.error}</span>
      )}
    </div>
  )
}
