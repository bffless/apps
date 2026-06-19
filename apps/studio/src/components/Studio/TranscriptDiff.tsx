import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  buildTranscriptGrid,
  cutColumns,
  formatClock,
  gridPosition,
  segmentsPerLine,
  windowLines,
  DEFAULT_SECONDS_PER_LINE,
  DEFAULT_SEGMENT_SECONDS,
  type TWord,
  type CutSpan,
  type GridLine,
} from '../../lib/transcriptGrid'
import { SegmentVoiceControl, type SegmentControl } from './SegmentVoiceControl'
import { claimPlayback, toggleClip } from './clipPlayer'
import { narrationSeconds } from '../../lib/scenes'
import { frameForRow, spriteStyle, type FilmFrame } from '../../lib/filmstrip'
import type { SearchHit } from '../../lib/search'

type Props = {
  /** The transcript from `/api/transcribe` — shown on the left ("original"). */
  words: TWord[]
  /** The working/shortened transcript — shown on the right. Defaults to a copy
   *  of `words` until the director/refiner produces a tightened version. */
  editedWords?: TWord[]
  /** Footage spans being dropped (refiner's `cuts`, else the director's), in
   *  original-video seconds. Rendered as red cells on the New pane only — the
   *  Original is an untouched reference; the deletion is from the working
   *  timeline, not the source. */
  cuts?: CutSpan[]
  /** Narration runs — an inline voice control (record / AI / play) renders on the
   *  New pane at each run's start row. */
  segments?: SegmentControl[]
  /** Whether a narration voice has been chosen (enables the AI option). */
  canGenerateAI?: boolean
  onGenerateAI?: (sceneId: string, index: number) => void
  onRecord?: (sceneId: string, index: number, blob: Blob) => void
  onUseOriginal?: (sceneId: string, index: number) => void
  /** Hand-edit the cuts by dragging on the grid. The drag's start cell decides
   *  the op: starting on kept footage **adds** a cut (drag to size / extend an
   *  adjacent one); starting on a red cell **removes** (contract or split). The
   *  span is in original-video seconds, snapped to whole cells. Omit to make the
   *  grid read-only (the prep previews). */
  onEditCut?: (span: CutSpan, op: 'add' | 'remove') => void
  /** Adopt a span of the ORIGINAL audio as a New-pane run (story 03d): drag-select
   *  a range on the Original pane to grab it, then click the New pane to drop it
   *  anywhere in the scene (story 03h — overlap allowed, clamped to the window).
   *  `dropTargets` are the empty gaps, kept as a lands-clean hint (glow + preview
   *  tint), no longer a gate. */
  dropTargets?: CutSpan[]
  onAdoptOriginal?: (origStart: number, origEnd: number, dropStart: number) => void
  /** Add a hand-typed narration run (the spec's "typed snippet"): type text in
   *  the toolbar bar, then click the New pane to drop it — an unvoiced run sized
   *  by the word-count estimate, voiced later via its Record / AI controls. */
  onAddSnippet?: (text: string, dropStart: number) => void
  /** Search the whole talk by meaning (story 08). The page runs the query
   *  through `/api/search-transcript` over the FULL transcript (this viewer
   *  only has the scene slice) and resolves hits annotated with the owning
   *  scene's title and the span's transcript `words` — each hit renders as a
   *  full-width "set": the same selectable time grid as the Original pane,
   *  windowed to the hit. Omit to hide the search affordance. */
  onSearch?: (query: string) => Promise<(SearchHit & { sceneTitle?: string; words?: TWord[] })[]>
  /** Delete a New-pane run (reopens its gap to make room). */
  onDeleteSegment?: (sceneId: string, index: number) => void
  /** Move a New-pane run (story 03h): vertical pointer-drag on its voice-control
   *  row → a snapped new start, clamped so the run never passes the scene end.
   *  Omit to make runs immovable. */
  onMoveRun?: (sceneId: string, index: number, newStart: number) => void
  /** Voice options for the per-segment picker (story 10d): cast people + presets.
   *  Omit to hide the picker. */
  voiceOptions?: { voiceId: string; label: string }[]
  /** Called when the producer picks a voice override for a segment. */
  onPickVoice?: (sceneId: string, index: number, voiceId: string) => void
  /** Overlapping run spans (story 03h) — painted as a distinct amber conflict
   *  fill on the New pane, with an "N to resolve" note by its header. Overlap is
   *  a legal in-progress state; assemble is gated on it elsewhere. */
  overlaps?: CutSpan[]
  /** Contact-sheet frames (story 03e) for the time-aligned filmstrip gutter down
   *  the left of the viewer. Empty ⇒ no gutter (e.g. before thumbnails exist). */
  frames?: FilmFrame[]
  /** The source clip's real length, in seconds. The grid is floored to this so
   *  trailing footage with no speech (e.g. the talk ends at 0:50 on a 0:53 clip)
   *  still renders editable rows — otherwise the grid stops at the last word and
   *  that footage can't be seen or cut. */
  duration?: number
  /** Restrict the viewer to one scene's window on the absolute timeline (story
   *  03c "per-scene scope"): rows before `windowStart` (floored to the line) and
   *  at/after `windowEnd` aren't rendered, so the diff shows only the selected
   *  `SceneTabs` tab and switching tabs re-scopes it. Timestamps stay absolute —
   *  scene 2 reads from 1:44, matching its footage span. Omit (0 / Infinity) to
   *  show the whole talk. */
  windowStart?: number
  windowEnd?: number
  /** The whole-source extracted audio (16 kHz WAV). When set, each Original-pane
   *  timestamp becomes a play button: click it to play the original audio from
   *  that second through the scene's `windowEnd`, with the playing row lit up and
   *  tracking the playhead. Omit (prep previews) to keep the gutter read-only. */
  originalAudioUrl?: string
}

/** An in-progress cut drag: the cell it began on, the cell under the pointer
 *  now, and the op fixed at pointer-down. */
type Drag = { start: number; end: number; op: 'add' | 'remove' }

/** A range being selected on the Original pane (or the grabbed clip). */
type Span = { start: number; end: number }


// Resizable split: the Original pane's width as a % of the row, clamped so
// neither pane can collapse. Persisted to localStorage so the panes come back
// the same size after a reload (a view preference, like seconds-per-line).
const SPLIT_KEY = 'studio.diff.leftPct'
const SPLIT_MIN = 20
const SPLIT_MAX = 80
const DEFAULT_SPLIT = 50

function readSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY))
    return Number.isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : DEFAULT_SPLIT
  } catch {
    return DEFAULT_SPLIT
  }
}

function writeSplit(pct: number) {
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(pct)))
  } catch {
    /* private mode / disabled storage — just don't persist */
  }
}

/** Last second any of these words occupies (0 if none / untimed). */
function lastSecond(words: TWord[]): number {
  let max = 0
  for (const w of words) {
    const t = typeof w.end === 'number' ? w.end : typeof w.start === 'number' ? w.start : 0
    if (t > max) max = t
  }
  return max
}

/** Per-pane voice controls — the New pane gets the real controls; the Original
 *  pane gets matching spacers so both stay row-aligned. */
type Controls = {
  canAI: boolean
  onGenerateAI: (sceneId: string, index: number) => void
  onRecord: (sceneId: string, index: number, blob: Blob) => void
  onPlay: (url: string) => void
  onDelete: (sceneId: string, index: number) => void
  /** Begin a move drag from this run's voice-control row (story 03h). */
  onMoveStart?: (seg: SegmentControl) => void
  /** Voice a run from the clip's own audio (story 03j). */
  onUseOriginal?: (sceneId: string, index: number) => void
  /** Voice options for the per-segment picker (cast + presets, story 10d). */
  voiceOptions?: { voiceId: string; label: string }[]
  /** Called when the producer picks a voice for a specific segment. */
  onPickVoice?: (sceneId: string, index: number, voiceId: string) => void
}

/**
 * A GitHub-diff-style view of the transcript on a time grid. Two panes side by
 * side — original (left) vs the new/shortened transcript (right). Line numbers
 * are timestamps; each row is `secondsPerLine` seconds sliced into
 * `segmentSeconds` cells. Both panes are pinned to the same height so timestamps
 * line up; dropped footage (`cuts`) is filled red on the New pane only (the
 * Original is an untouched reference). Each narration run gets an inline voice
 * control (record / AI / play) on the New pane.
 */
export function TranscriptDiff({
  words,
  editedWords,
  cuts = [],
  segments = [],
  canGenerateAI = false,
  onGenerateAI,
  onRecord,
  onUseOriginal,
  onEditCut,
  dropTargets = [],
  onAdoptOriginal,
  onDeleteSegment,
  onMoveRun,
  onAddSnippet,
  onSearch,
  overlaps = [],
  frames = [],
  duration = 0,
  windowStart = 0,
  windowEnd = Infinity,
  originalAudioUrl,
  voiceOptions,
  onPickVoice,
}: Props) {
  const [secondsPerLine, setSecondsPerLine] = useState(DEFAULT_SECONDS_PER_LINE)
  const [segmentSeconds, setSegmentSeconds] = useState(DEFAULT_SEGMENT_SECONDS)
  // Tall-rows mode: grow EVERY row to a full frame's height so the filmstrip
  // shows whole frames (not just the centred band) while staying aligned to the
  // words. Default on; toggle off for compact rows + hover-to-peek.
  const [tallRows, setTallRows] = useState(true)
  const right = editedWords ?? words

  // Resizable panes: drag the divider to give the New pane more room. `leftPct`
  // is the Original pane's width; the New pane takes the rest. Lazy-initialised
  // from (and persisted back to) localStorage so it survives a reload.
  const containerRef = useRef<HTMLDivElement>(null)
  const [leftPct, setLeftPct] = useState(readSplit)
  const [resizing, setResizing] = useState(false)

  // Fully collapse one pane (the divider only drags so far) — a header button
  // hides it and a slim labelled rail stays in its place to bring it back, so
  // there's always a way to uncollapse. Setting one side reopens the other, so
  // the viewer can never end up with zero panes. Transient view state.
  const [collapsed, setCollapsed] = useState<'left' | 'right' | null>(null)

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: PointerEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct)))
    }
    const stop = () => setResizing(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [resizing])

  // Persist only once the drag settles (not on every move), and the no-op write
  // on mount is harmless.
  useEffect(() => {
    if (!resizing) writeSplit(leftPct)
  }, [resizing, leftPct])

  // Cut hand-editing: a pointer-drag across cells (story 03d). The op is fixed at
  // pointer-down by the start cell's state, so the whole gesture either adds or
  // removes. Commit on pointer-up anywhere (window listener) so releasing off the
  // grid still lands the edit. `pending` previews the affected span as you drag.
  const editable = !!onEditCut
  const [drag, setDrag] = useState<Drag | null>(null)

  const onCellDown = useCallback(
    (time: number, isCut: boolean) => {
      if (!editable) return
      setDrag({ start: time, end: time, op: isCut ? 'remove' : 'add' })
    },
    [editable],
  )
  const onCellEnter = useCallback((time: number) => {
    setDrag((d) => (d ? { ...d, end: time } : d))
  }, [])

  useEffect(() => {
    if (!drag || !onEditCut) return
    const commit = () => {
      setDrag((d) => {
        if (d) {
          const start = Math.min(d.start, d.end)
          const end = Math.max(d.start, d.end) + segmentSeconds // include the end cell's slot
          onEditCut({ start, end }, d.op)
        }
        return null
      })
    }
    window.addEventListener('pointerup', commit)
    return () => window.removeEventListener('pointerup', commit)
  }, [drag, onEditCut, segmentSeconds])

  const cutPending: CutSpan | null = drag
    ? { start: Math.min(drag.start, drag.end), end: Math.max(drag.start, drag.end) + segmentSeconds }
    : null

  // Adopt-original (story 03d): a two-step grab-then-place. Step 1 — drag-select a
  // range on the Original pane → `clipSel`, finalised on pointer-up into the
  // grabbed `pendingClip`. Step 2 — the New pane enters "place" mode, glows the
  // gaps, and a click on a gap the clip fits into drops it there.
  const canAdopt = !!onAdoptOriginal
  const [clipSel, setClipSel] = useState<Span | null>(null)
  const [pendingClip, setPendingClip] = useState<Span | null>(null)
  // Typed snippet (type-then-place): `snippetText` non-null = the toolbar input
  // bar is open; `pendingSnippet` = text confirmed, New pane in place mode with
  // a footprint sized by the word-count estimate.
  const [snippetText, setSnippetText] = useState<string | null>(null)
  const [pendingSnippet, setPendingSnippet] = useState<{ text: string; duration: number } | null>(
    null,
  )
  // The New-pane cell the cursor is over while placing — anchors the footprint
  // preview so it shows exactly where (and how many cells) the clip will land.
  const [hoverTime, setHoverTime] = useState<number | null>(null)

  // Transcript search (story 08): `searchOpen` shows the query bar; hits are
  // transient — closing the bar clears them. Each hit renders as a full-width
  // "set" Pane sharing the Original pane's select-mode handlers, so grabbing
  // from a set IS the Original-pane gesture (drag cells → place).
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchHits, setSearchHits] = useState<
    (SearchHit & { sceneTitle?: string; words?: TWord[] })[] | null
  >(null)

  // Pointer-down on the Original pane. While a clip is grabbed (`pendingClip`),
  // standard selection semantics apply: shift-click extends the grabbed span to
  // the clicked cell (anchored at whichever edge stays put), a plain click drops
  // it and starts a fresh selection — so a selection interrupted by scrolling
  // can be continued with shift instead of redone from scratch.
  const onSelDown = useCallback(
    (time: number, _isCut: boolean, extend?: boolean) => {
      if (!canAdopt) return
      if (extend && pendingClip) {
        setPendingClip(
          time >= pendingClip.start
            ? { start: pendingClip.start, end: time + segmentSeconds }
            : { start: time, end: pendingClip.end },
        )
        return
      }
      if (pendingClip) setPendingClip(null)
      setPendingSnippet(null) // one placement gesture at a time
      setClipSel({ start: time, end: time })
    },
    [canAdopt, pendingClip, segmentSeconds],
  )
  const onSelEnter = useCallback((time: number) => {
    setClipSel((s) => (s ? { ...s, end: time } : s))
  }, [])

  useEffect(() => {
    if (!clipSel) return
    const commit = () => {
      setClipSel((s) => {
        if (s) {
          const start = Math.min(s.start, s.end)
          const end = Math.max(s.start, s.end) + segmentSeconds
          setHoverTime(null) // no stale footprint until the cursor moves onto a gap
          setPendingClip({ start, end })
        }
        return null
      })
    }
    window.addEventListener('pointerup', commit)
    return () => window.removeEventListener('pointerup', commit)
  }, [clipSel, segmentSeconds])

  // Esc cancels a grabbed-but-unplaced clip / a pending snippet placement.
  useEffect(() => {
    if (!pendingClip && !pendingSnippet) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingClip(null)
        setPendingSnippet(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingClip, pendingSnippet])

  // Drops and moves land anywhere in the scene window (story 03h) — the only
  // constraint left is the within-scene clamp: shift the start so the footprint
  // never passes the window end, floored at its start. (The model clamps to the
  // scene again; this keeps the preview honest about where it will land.)
  const clampPlace = useCallback(
    (time: number, duration: number) => {
      const hi = Number.isFinite(windowEnd) ? windowEnd - duration : time
      return Math.max(windowStart, Math.min(time, hi))
    },
    [windowStart, windowEnd],
  )

  // What's being placed: a grabbed clip or a typed snippet. Both drive the same
  // footprint preview + drop plumbing, differing only in duration and payload.
  const clipDuration = pendingClip ? pendingClip.end - pendingClip.start : 0
  const placeDuration = pendingSnippet ? pendingSnippet.duration : clipDuration
  const placing = !!pendingClip || !!pendingSnippet
  // Lands-clean hint (story 03h): no longer gates the drop, only tints the
  // footprint preview green (fits a gap) vs terracotta (will overlap a run).
  const fitsAt = useCallback(
    (time: number) => dropTargets.some((g) => time >= g.start - 0.05 && time + placeDuration <= g.end + 0.05),
    [dropTargets, placeDuration],
  )
  const onDrop = useCallback(
    (time: number) => {
      if (pendingSnippet && onAddSnippet) {
        onAddSnippet(pendingSnippet.text, clampPlace(time, pendingSnippet.duration))
        setPendingSnippet(null)
        return
      }
      if (!pendingClip || !onAdoptOriginal) return
      onAdoptOriginal(pendingClip.start, pendingClip.end, clampPlace(time, clipDuration))
      setPendingClip(null)
    },
    [pendingSnippet, onAddSnippet, pendingClip, onAdoptOriginal, clampPlace, clipDuration],
  )

  // The footprint the clip/snippet would occupy at the hovered cell (clamped, so
  // it shows exactly where the drop lands) — green when it fits a gap clean,
  // terracotta when it will overlap a run. Both are droppable.
  const placeStart = placing && hoverTime != null ? clampPlace(hoverTime, placeDuration) : null
  const placePreview: CutSpan | null =
    placeStart != null ? { start: placeStart, end: placeStart + placeDuration } : null
  const placeFits = placeStart != null && fitsAt(placeStart)

  // Move a run (story 03h): pointer-down on its voice-control row grabs it; the
  // grid cells under the pointer report their time through the same pointerenter
  // plumbing as cut-paint, previewing the run's new band; pointer-up commits the
  // snapped, clamped move. Vertical drag on the control row, so it never collides
  // with cut-painting (which owns drags that START on the cells).
  const [moveSel, setMoveSel] = useState<{ sceneId: string; index: number; duration: number } | null>(null)
  const [moveHover, setMoveHover] = useState<number | null>(null)

  const onMoveStart = useCallback(
    (seg: SegmentControl) => {
      setMoveHover(null)
      setMoveSel({ sceneId: seg.sceneId, index: seg.index, duration: seg.end - seg.start })
    },
    [],
  )

  useEffect(() => {
    if (!moveSel) return
    const commit = () => {
      if (moveHover != null && onMoveRun) {
        onMoveRun(moveSel.sceneId, moveSel.index, clampPlace(moveHover, moveSel.duration))
      }
      setMoveSel(null)
      setMoveHover(null)
    }
    window.addEventListener('pointerup', commit)
    return () => window.removeEventListener('pointerup', commit)
  }, [moveSel, moveHover, onMoveRun, clampPlace])

  const moveStart = moveSel && moveHover != null ? clampPlace(moveHover, moveSel.duration) : null
  const movePreview: CutSpan | null =
    moveSel && moveStart != null ? { start: moveStart, end: moveStart + moveSel.duration } : null

  // The grabbed/selecting span to outline on the Original pane.
  const selPreview: CutSpan | null = pendingClip
    ? pendingClip
    : clipSel
      ? { start: Math.min(clipSel.start, clipSel.end), end: Math.max(clipSel.start, clipSel.end) + segmentSeconds }
      : null

  // LEFT pane: drag to grab a clip. Stays live once one is grabbed — shift-click
  // extends the grabbed span, a plain click starts a new selection (onSelDown
  // decides); onSelEnter is a no-op unless a drag is in progress.
  const leftEdit: CellEdit | null = canAdopt
    ? {
        mode: 'select',
        onCellDown: onSelDown,
        onCellEnter: onSelEnter,
        preview: selPreview,
        previewKind: 'select',
        glow: [],
      }
    : null

  // RIGHT pane: a run-move drag wins (its preview band tracks the cursor), then
  // place mode while a clip is grabbed (gaps faintly tinted as the lands-clean
  // hint, footprint preview under the cursor — any cell is droppable), else
  // cut-paint.
  const rightEdit: CellEdit | null = moveSel
    ? {
        mode: 'place',
        onCellEnter: setMoveHover,
        glow: [],
        preview: movePreview,
        previewKind: movePreview ? 'place-ok' : null,
      }
    : placing
      ? {
          mode: 'place',
          onCellEnter: setHoverTime,
          onCellClick: onDrop,
          glow: dropTargets,
          preview: placePreview,
          previewKind: placePreview ? (placeFits ? 'place-ok' : 'place-bad') : null,
        }
      : editable
        ? { mode: 'cut', onCellDown, onCellEnter, preview: cutPending, previewKind: drag?.op ?? null, glow: [] }
        : null

  // Play the ORIGINAL scene audio from a clicked timestamp. The Original pane's
  // gutter timestamps are play buttons; clicking one seeks the whole-source WAV
  // to that absolute second and plays through the scene's `windowEnd`.
  // `playheadSec` lights the row the playhead is in and tracks it as it advances;
  // clicking the row that's currently playing pauses it.
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playheadSec, setPlayheadSec] = useState<number | null>(null)
  // Stop-bound override (story 08): search-hit playback ends at the HIT's end,
  // not the scene window — search is whole-talk, a hit may live in another
  // scene. Null = the default window bound.
  const [stopAt, setStopAt] = useState<number | null>(null)

  const playFrom = useCallback(
    (startSec: number, stopSec?: number) => {
      const el = audioRef.current
      if (!el) return
      // toggle: clicking the row the playhead is already in pauses it
      if (!el.paused && playheadSec != null && playheadSec >= startSec && playheadSec < startSec + secondsPerLine) {
        el.pause()
        return
      }
      setStopAt(stopSec ?? null)
      claimPlayback(el)
      setPlayheadSec(startSec) // light the row immediately, before the first timeupdate
      const start = () => {
        el.currentTime = startSec
        void el.play().catch(() => {})
      }
      // `preload="metadata"` may not be ready on the first click — seek once the
      // element knows its duration, else `currentTime` is dropped and it plays
      // from 0 (lighting the wrong row).
      if (el.readyState >= 1) start()
      else el.addEventListener('loadedmetadata', start, { once: true })
    },
    [playheadSec, secondsPerLine],
  )

  // Play exactly one hit's span (story 08) — same element + claim as playFrom,
  // but with its own stop bound.
  const playSpan = useCallback(
    (startSec: number, endSec: number) => {
      const el = audioRef.current
      if (!el) return
      if (!el.paused && playheadSec != null && playheadSec >= startSec && playheadSec < endSec) {
        el.pause() // toggle: already playing this hit
        return
      }
      claimPlayback(el)
      setStopAt(endSec)
      setPlayheadSec(startSec)
      const start = () => {
        el.currentTime = startSec
        void el.play().catch(() => {})
      }
      if (el.readyState >= 1) start()
      else el.addEventListener('loadedmetadata', start, { once: true })
    },
    [playheadSec],
  )

  const stop = useCallback(() => audioRef.current?.pause(), [])

  // Track the playhead → lit row; stop at the scene's end so it doesn't bleed
  // into the next scene's audio. Clearing the lit row is driven by the element's
  // own pause/ended events (not setState-in-effect), so a scene switch that just
  // pauses the audio also clears the highlight.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = () => {
      const limit = stopAt ?? windowEnd
      if (Number.isFinite(limit) && el.currentTime >= limit) {
        el.pause()
        return
      }
      setPlayheadSec(el.currentTime)
    }
    const clear = () => setPlayheadSec(null)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('pause', clear)
    el.addEventListener('ended', clear)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('pause', clear)
      el.removeEventListener('ended', clear)
    }
  }, [windowEnd, stopAt])

  // Switching scenes (or swapping the source) stops playback — the resulting
  // `pause` event clears the lit row — so audio never carries over from the
  // scene you just left.
  useEffect(() => {
    audioRef.current?.pause()
  }, [windowStart, windowEnd, originalAudioUrl])

  // Pin both panes to the same span: the latest of either transcript, any cut, or
  // the clip's real `duration`, so they're equal height and trailing footage with
  // no words/cuts (the talk ends before the clip does) still renders editable rows.
  // When scoped to a scene, the floor is the scene's `windowEnd` (its footage runs
  // there even past the last word), not the whole-clip `duration`.
  const span = useMemo(() => {
    const cutEnd = cuts.reduce((m, c) => Math.max(m, c.end), 0)
    const words_ = Math.max(lastSecond(words), lastSecond(right), cutEnd)
    return Number.isFinite(windowEnd) ? Math.max(words_, windowEnd) : Math.max(words_, duration)
  }, [words, right, cuts, duration, windowEnd])

  const controls: Controls | null = onGenerateAI && onRecord
    ? {
        canAI: canGenerateAI,
        onGenerateAI,
        onRecord,
        onPlay: toggleClip,
        onDelete: onDeleteSegment ?? (() => {}),
        onMoveStart: onMoveRun ? onMoveStart : undefined,
        onUseOriginal,
        voiceOptions,
        onPickVoice,
      }
    : null

  // A full frame's display height at the gutter width (its real aspect, so it's
  // not letterboxed). The tall-rows toggle grows every row to this; otherwise
  // rows stay at the compact band height.
  const fullRowHeight = useMemo(() => {
    const f = frames[0]
    if (!f?.sheet.cellWidth) return FILMSTRIP_ROW
    return Math.round(f.sheet.cellHeight * (FILMSTRIP_WIDTH / f.sheet.cellWidth))
  }, [frames])
  const rowHeight = tallRows ? fullRowHeight : FILMSTRIP_ROW

  return (
    <div className="border rule bg-paper">
      {originalAudioUrl && (
        <audio ref={audioRef} src={originalAudioUrl} preload="metadata" className="hidden" />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b rule px-5 py-3">
        <div>
          <p className="meta-label">Transcript · time grid</p>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">
            Line numbers are timestamps · rows are {secondsPerLine}s, one cell per{' '}
            {segmentSeconds === 1 ? 'second' : `${segmentSeconds}s`} ·{' '}
            <span className="text-terracotta-ink">red</span> = cut ·{' '}
            <span className="text-voice-ink">green</span> = voiced
            {overlaps.length > 0 && (
              <>
                {' · '}
                <span className="text-amber-700">amber</span> = overlapping runs
              </>
            )}
            {editable && ' · drag empty cells to cut, drag red cells to un-cut'}
            {canAdopt && !pendingClip && ' · drag the Original to reuse its audio'}
            {onMoveRun && segments.length > 0 && ' · drag a run’s ⠿ handle to re-time it'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 font-mono text-[12px] text-ink-mute">
          {onSearch && !searchOpen && (
            <button
              type="button"
              className="border rule bg-paper px-2 py-1 text-ink transition-colors hover:bg-paper-deep/40"
              onClick={() => setSearchOpen(true)}
            >
              ⌕ Search
            </button>
          )}
          {onAddSnippet && snippetText == null && !pendingSnippet && (
            <button
              type="button"
              className="border rule bg-paper px-2 py-1 text-ink transition-colors hover:bg-paper-deep/40"
              onClick={() => setSnippetText('')}
            >
              ＋ Add snippet
            </button>
          )}
          <label className="flex items-center gap-2">
            seconds / line
            <Select
              value={secondsPerLine}
              onChange={setSecondsPerLine}
              options={LINE_OPTIONS.map((n) => ({ label: String(n), value: n }))}
            />
          </label>
          <label className="flex items-center gap-2">
            segment
            <Select value={segmentSeconds} onChange={setSegmentSeconds} options={SEGMENT_OPTIONS} />
          </label>
          {frames.length > 0 && (
            <button
              type="button"
              aria-pressed={tallRows}
              onClick={() => setTallRows((v) => !v)}
              className={[
                'border rule px-2 py-1 text-ink transition-colors',
                tallRows ? 'bg-ink text-paper' : 'bg-paper hover:bg-paper-deep/40',
              ].join(' ')}
            >
              {tallRows ? 'compact rows' : 'tall frames'}
            </button>
          )}
        </div>
      </div>

      {snippetText != null && (
        // Typed snippet, step 1: write the text. The estimate updates live so
        // the producer sees the footprint they're about to place.
        <form
          className="flex flex-wrap items-center gap-3 border-b rule bg-paper-deep/40 px-5 py-2 text-[12.5px] text-ink-soft"
          onSubmit={(e) => {
            e.preventDefault()
            const text = snippetText.trim()
            if (!text) return
            setHoverTime(null) // no stale footprint until the cursor moves
            setPendingSnippet({ text, duration: narrationSeconds(text) })
            setSnippetText(null)
          }}
        >
          <input
            autoFocus
            value={snippetText}
            onChange={(e) => setSnippetText(e.target.value)}
            placeholder="Type the new narration snippet…"
            aria-label="Snippet text"
            className="min-w-48 flex-1 border rule bg-paper px-2 py-1 text-[13px] text-ink outline-none placeholder:text-ink-faint"
          />
          <span className="font-mono text-[11px] text-ink-mute">
            ≈{narrationSeconds(snippetText.trim()).toFixed(1)}s
          </span>
          <button
            type="submit"
            disabled={!snippetText.trim()}
            className="rounded border border-paper-line px-2 py-0.5 text-[11px] text-ink hover:bg-paper disabled:opacity-50"
          >
            Place
          </button>
          <button
            type="button"
            className="rounded border border-paper-line px-2 py-0.5 text-[11px] text-ink hover:bg-paper"
            onClick={() => setSnippetText(null)}
          >
            Cancel
          </button>
        </form>
      )}

      {searchOpen && (
        // Transcript search (story 08): query bar + results. Hits are whole-talk;
        // Play previews the span's original audio, Grab enters place mode.
        <div className="border-b rule bg-paper-deep/40">
          <form
            className="flex flex-wrap items-center gap-3 px-5 py-2 text-[12.5px] text-ink-soft"
            onSubmit={(e) => {
              e.preventDefault()
              const q = searchQuery.trim()
              if (!q || !onSearch || searchBusy) return
              setSearchBusy(true)
              onSearch(q)
                .then(setSearchHits)
                .catch(() => setSearchHits([]))
                .finally(() => setSearchBusy(false))
            }}
          >
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search the talk — “where I sound excited”, “the bike ride”…"
              aria-label="Search query"
              className="min-w-48 flex-1 border rule bg-paper px-2 py-1 text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="submit"
              disabled={!searchQuery.trim() || searchBusy}
              className="rounded border border-paper-line px-2 py-0.5 text-[11px] text-ink hover:bg-paper disabled:opacity-50"
            >
              {searchBusy ? 'Searching…' : 'Search'}
            </button>
            <button
              type="button"
              className="rounded border border-paper-line px-2 py-0.5 text-[11px] text-ink hover:bg-paper"
              onClick={() => {
                setSearchOpen(false)
                setSearchHits(null)
              }}
            >
              Close
            </button>
          </form>
          {searchHits && (
            // Result SETS: each hit is the same selectable time grid as the
            // Original pane (shared `leftEdit` select-mode handlers), windowed
            // to the hit's span and spanning the full viewer width — drag its
            // cells to grab, then click the New pane to place, exactly like
            // the Original. Capped tall; the list scrolls.
            <div className="max-h-[28rem] overflow-y-auto border-t rule">
              {searchHits.length === 0 && (
                <p className="px-5 py-2 text-[12px] text-ink-mute">
                  No matches — try different words.
                </p>
              )}
              {searchHits.map((hit, i) =>
                hit.words?.length ? (
                  <div key={`${hit.start}-${i}`} className="border-b rule last:border-b-0">
                    <Pane
                      label={`${formatClock(hit.start)}–${formatClock(hit.end)}`}
                      sublabel={hit.sceneTitle ?? 'search result'}
                      words={hit.words}
                      secondsPerLine={secondsPerLine}
                      segmentSeconds={segmentSeconds}
                      cuts={[]}
                      minSeconds={hit.end}
                      windowStart={hit.start}
                      windowEnd={hit.end}
                      segments={[]}
                      controls={null}
                      edit={leftEdit}
                      rowHeight={FILMSTRIP_ROW}
                      onPlayFrom={
                        originalAudioUrl ? (sec) => playFrom(sec, hit.end) : undefined
                      }
                      playheadSec={playheadSec}
                      headerExtra={
                        <>
                          {hit.reason && (
                            <span className="text-[11px] italic normal-case tracking-normal text-ink-mute">
                              {hit.reason}
                            </span>
                          )}
                          {originalAudioUrl && (
                            <button
                              type="button"
                              className="rounded border border-paper-line px-2 py-0.5 font-mono text-[11px] text-ink hover:bg-paper-deep/40"
                              onClick={() => playSpan(hit.start, hit.end)}
                            >
                              ▶ Play
                            </button>
                          )}
                        </>
                      }
                    />
                  </div>
                ) : (
                  <p
                    key={`${hit.start}-${i}`}
                    className="border-b rule px-5 py-2 text-[12.5px] text-ink last:border-b-0"
                  >
                    <span className="font-mono text-[11px] text-ink-mute">
                      {formatClock(hit.start)}–{formatClock(hit.end)}
                    </span>{' '}
                    “{hit.snippet}”
                  </p>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {placing && (
        // Sticky so the "what am I placing" cue stays put as the long grid below
        // scrolls. `--diff-sticky-top` (set by the page) parks it just under the
        // sticky scene tabs; falls back to the header height alone. Frosted +
        // z-20 so grid rows scroll cleanly beneath it (under the tabs at z-30).
        <div className="sticky top-[var(--diff-sticky-top,3.5rem)] z-20 flex flex-wrap items-center gap-3 border-b rule bg-voice/20 px-5 py-2 text-[12.5px] text-ink-soft backdrop-blur">
          <span>
            Placing <span className="font-mono text-voice-ink">{placeDuration.toFixed(1)}s</span>{' '}
            {pendingSnippet ? 'snippet — click the New pane to drop it' : 'of original audio'}
          </span>
          <button
            type="button"
            className="ml-auto rounded border border-paper-line px-2 py-0.5 text-[11px] text-ink hover:bg-paper"
            onClick={() => {
              setPendingClip(null)
              setPendingSnippet(null)
            }}
          >
            Cancel (Esc)
          </button>
        </div>
      )}

      {/* "Now playing" cue — sticky (parked under the scene tabs like the placing
          bar) so the Stop control is reachable no matter how far the scene has
          scrolled. Tracks the playhead second; Stop pauses (which clears the lit
          row via the element's pause event). */}
      {playheadSec != null && (
        <div className="sticky top-[var(--diff-sticky-top,3.5rem)] z-20 flex items-center gap-3 border-b rule bg-terracotta/15 px-5 py-2 text-[12.5px] text-ink-soft backdrop-blur">
          <span className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-terracotta" />
            Playing original audio ·{' '}
            <span className="font-mono text-terracotta-ink">{formatClock(playheadSec)}</span>
          </span>
          <button
            type="button"
            className="ml-auto bg-transparent px-1 py-0.5 text-[11px] text-ink-soft transition-colors hover:text-terracotta"
            onClick={stop}
          >
            ■ Stop
          </button>
        </div>
      )}

      <div className="flex flex-col lg:flex-row">
        {/* story 03e: a time-aligned frame gutter, left of the Original pane. It
            mirrors the Original pane's row structure (same grid + segment
            spacers) so it stays in lockstep at any zoom. Only meaningful in the
            lg side-by-side layout. */}
        {frames.length > 0 && (
          <div className="hidden shrink-0 border-r rule lg:block" style={{ width: FILMSTRIP_WIDTH }}>
            <Filmstrip
              words={words}
              secondsPerLine={secondsPerLine}
              segmentSeconds={segmentSeconds}
              minSeconds={span}
              windowStart={windowStart}
              windowEnd={windowEnd}
              segments={segments}
              frames={frames}
              rowHeight={rowHeight}
            />
          </div>
        )}
        <div
          ref={containerRef}
          className={['flex min-w-0 flex-1 flex-col lg:flex-row', resizing ? 'select-none' : ''].join(' ')}
          style={{ '--lw': `${leftPct}%` } as CSSProperties}
        >
          {collapsed === 'left' ? (
            <CollapsedRail label="Original" onExpand={() => setCollapsed(null)} />
          ) : (
            <div
              className={[
                'min-w-0 border-b rule lg:border-b-0',
                // the other pane collapsed ⇒ take the whole row; else the split %
                collapsed === 'right' ? 'lg:flex-1' : 'lg:basis-[var(--lw)] lg:shrink-0 lg:grow-0',
              ].join(' ')}
            >
          <Pane
            label="Original"
            sublabel="from transcription"
            words={words}
            secondsPerLine={secondsPerLine}
            segmentSeconds={segmentSeconds}
            cuts={[]}
            minSeconds={span}
            windowStart={windowStart}
            windowEnd={windowEnd}
            segments={segments}
            controls={null}
            edit={leftEdit}
            rowHeight={rowHeight}
            onPlayFrom={originalAudioUrl ? playFrom : undefined}
            playheadSec={playheadSec}
            onCollapse={() => setCollapsed('left')}
          />
        </div>
        )}
        {/* drag handle — only meaningful in the lg side-by-side layout, and only
            while both panes are open (collapse owns the all-the-way case) */}
        {collapsed === null && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(e) => {
              e.preventDefault()
              setResizing(true)
            }}
            className="hidden shrink-0 cursor-col-resize bg-paper-line transition-colors hover:bg-terracotta/50 lg:block lg:w-1.5"
          />
        )}
        {collapsed === 'right' ? (
          <CollapsedRail label="New" onExpand={() => setCollapsed(null)} />
        ) : (
          <div className="min-w-0 lg:flex-1">
          <Pane
            label="New"
            sublabel={editedWords ? 'shortened' : 'copy — shorten in prep'}
            words={right}
            secondsPerLine={secondsPerLine}
            segmentSeconds={segmentSeconds}
            cuts={cuts}
            overlaps={overlaps}
            minSeconds={span}
            windowStart={windowStart}
            windowEnd={windowEnd}
            segments={segments}
            controls={controls}
            edit={rightEdit}
            rowHeight={rowHeight}
            onCollapse={() => setCollapsed('right')}
          />
        </div>
        )}
        </div>
      </div>
    </div>
  )
}

/** Gutter width (px) for the 03e filmstrip — wide enough that a flat row crop is
 *  still legible; only shown in the lg side-by-side layout. */
const FILMSTRIP_WIDTH = 150
/** Gutter row height (px) — matches the grid Row's `min-h-[2rem]` so the frames
 *  stay aligned to the timestamps row-for-row. */
const FILMSTRIP_ROW = 32

const LINE_OPTIONS = [2, 3, 5, 10]
const SEGMENT_OPTIONS = [
  { label: '1s', value: 1 },
  { label: '0.5s', value: 0.5 },
  { label: '0.25s', value: 0.25 },
  { label: '0.1s', value: 0.1 },
]

function Select<T extends number>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { label: string; value: T }[]
}) {
  return (
    <select
      className="border rule bg-paper px-2 py-1 text-ink"
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/**
 * The strip left behind by a collapsed pane: a single full-height button that
 * names the hidden pane and brings it back. Vertical (writing-mode) in the lg
 * side-by-side layout, a plain horizontal bar when the panes stack.
 */
function CollapsedRail({ label, onExpand }: { label: string; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Show the ${label} pane`}
      aria-label={`Show the ${label} pane`}
      className="flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border-b rule bg-paper-deep/30 px-2 py-2 font-mono text-[11px] uppercase tracking-wider text-ink-mute transition-colors hover:bg-paper-deep/60 hover:text-ink lg:w-8 lg:border-b-0 lg:px-0 lg:py-4 lg:[writing-mode:vertical-rl]"
    >
      <span aria-hidden>⊞</span>
      {label}
    </button>
  )
}

/**
 * Per-cell interaction handed to a pane — three modes:
 * - `cut`    (New pane): pointer-drag to add/remove cuts; `preview` outlines it.
 * - `select` (Original pane): pointer-drag to grab an original-audio span.
 * - `place`  (New pane, while a clip is grabbed or a run is being moved): `glow`
 *   hints the gaps; any cell takes the drop (`onCellClick`) — the footprint is
 *   clamped and overlap is allowed (story 03h).
 */
type CellEdit = {
  mode: 'cut' | 'select' | 'place'
  /** `extend` = shift was held — select mode grows the grabbed span to this cell
   *  instead of starting a fresh selection. */
  onCellDown?: (time: number, isCut: boolean, extend?: boolean) => void
  onCellEnter?: (time: number) => void
  onCellClick?: (time: number) => void
  /** A span to outline: the cut being painted, the original span being grabbed,
   *  or — in place mode — the clip/run's footprint under the cursor. */
  preview: CutSpan | null
  previewKind: 'add' | 'remove' | 'select' | 'place-ok' | 'place-bad' | null
  /** Gaps to faintly tint so the lands-clean space is visible before hovering. */
  glow: CutSpan[]
}

type PaneProps = {
  label: string
  sublabel: string
  words: TWord[]
  secondsPerLine: number
  segmentSeconds: number
  cuts: CutSpan[]
  /** Overlapping run spans (story 03h) — the amber conflict fill (New pane). */
  overlaps?: CutSpan[]
  minSeconds: number
  /** Scene window on the absolute timeline — rows outside it are cropped so the
   *  pane shows only the selected scene (story 03c). 0 / Infinity ⇒ whole talk. */
  windowStart: number
  windowEnd: number
  segments: SegmentControl[]
  controls: Controls | null
  edit: CellEdit | null
  /** Minimum height (px) for each grid row — the tall-rows toggle drives this so
   *  the panes grow in lockstep with the filmstrip's full-frame cells. */
  rowHeight: number
  /** When set, each row's timestamp becomes a play button (start that second).
   *  Original pane only — omit to keep the gutter read-only. */
  onPlayFrom?: (startSec: number) => void
  /** The audio playhead, in absolute seconds — the row containing it lights up.
   *  null when nothing is playing. */
  playheadSec?: number | null
  /** Fully hide this pane (a labelled rail stays behind to restore it). */
  onCollapse?: () => void
  /** Extra header content, right-aligned (search sets: the hit's reason + Play). */
  headerExtra?: ReactNode
}

/**
 * The 03e filmstrip gutter — a frame for each grid row, down the left of the
 * viewer. It runs the SAME `buildTranscriptGrid` + segment-row mapping as the
 * Original pane (and emits the same per-segment spacer), so it stays aligned to
 * the timestamps row-for-row at any zoom — no time→pixel ruler that would drift
 * past the voice-control spacers. Each row shows the contact-sheet frame nearest
 * its start second, sprite-cropped from its sheet (no new image generation).
 */
function Filmstrip({
  words,
  secondsPerLine,
  segmentSeconds,
  minSeconds,
  windowStart,
  windowEnd,
  segments,
  frames,
  rowHeight,
}: {
  words: TWord[]
  secondsPerLine: number
  segmentSeconds: number
  minSeconds: number
  windowStart: number
  windowEnd: number
  segments: SegmentControl[]
  frames: FilmFrame[]
  rowHeight: number
}) {
  const lines = useMemo(
    () =>
      windowLines(
        buildTranscriptGrid(words, secondsPerLine, segmentSeconds, minSeconds),
        windowStart,
        windowEnd,
        secondsPerLine,
      ),
    [words, secondsPerLine, segmentSeconds, minSeconds, windowStart, windowEnd],
  )
  // Same row→segment mapping as a Pane, so the spacers land on the same rows.
  const segRows = useMemo(() => {
    const rows = new Set<number>()
    for (const s of segments) rows.add(Math.floor(Math.max(0, s.start) / secondsPerLine))
    return rows
  }, [segments, secondsPerLine])

  // Click a thumbnail to inspect it full-size (the strip is only 150px wide).
  const [zoomFrame, setZoomFrame] = useState<FilmFrame | null>(null)

  return (
    <div className="bg-paper">
      {/* header height matches a Pane header so row 0 aligns across the columns */}
      <div className="flex items-baseline gap-2 px-4 py-2.5">
        <span className="font-serif text-[15px] text-ink">Frames</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">video</span>
      </div>
      <div className="pb-2">
        {lines.map((line) => {
          const frame = frameForRow(frames, line.startSec)
          return (
            <div key={line.index}>
              {segRows.has(line.index) && (
                <div className="h-9 border-t border-paper-line/60 bg-paper-deep/20" />
              )}
              {/* Divider on the wrapper (outside the sized box) mirrors the Pane
                  Row's border placement, so the gutter and the panes stay exactly
                  row-aligned (no 1px-per-row drift). Compact rows clip the taller
                  frame to its centred band so it fills the cell, and hover pops
                  the WHOLE frame — the cut-off top and bottom — over its
                  neighbours, with a slight border. In tall-rows mode the cell is
                  already the full frame height, so the whole frame just shows. */}
              <div className="border-t border-paper-line/60">
                {frame && frame.sheet.width > 0 ? (
                  <button
                    type="button"
                    onClick={() => setZoomFrame(frame)}
                    title="Click to view full-size"
                    aria-label={`View frame at ${formatClock(line.startSec)} full-size`}
                    className="group relative block cursor-zoom-in appearance-none overflow-hidden border-0 bg-paper-deep p-0 outline-none hover:z-10 hover:overflow-visible"
                    style={{ width: FILMSTRIP_WIDTH, height: rowHeight }}
                  >
                    <div
                      className="absolute left-0 top-1/2 -translate-y-1/2 bg-paper-deep ring-ink-faint transition-shadow group-hover:ring-1 group-hover:shadow-lg group-hover:shadow-ink/30"
                      style={spriteStyle(frame, FILMSTRIP_WIDTH)}
                    />
                  </button>
                ) : (
                  <div className="bg-paper-deep" style={{ width: FILMSTRIP_WIDTH, height: rowHeight }} />
                )}
              </div>
            </div>
          )
        })}
      </div>
      {zoomFrame && <FrameZoomDialog frame={zoomFrame} onClose={() => setZoomFrame(null)} />}
    </div>
  )
}

/**
 * Lightbox for one filmstrip frame: the same contact-sheet sprite crop, just
 * rendered big (no new image fetch — the sheet is already loaded). Native
 * `<dialog>`: Esc / backdrop / ✕ all close it.
 */
function FrameZoomDialog({ frame, onClose }: { frame: FilmFrame; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dlg = ref.current
    if (dlg && !dlg.open) dlg.showModal()
  }, [])
  // Sized once on open — as big as the viewport comfortably allows.
  const width = Math.min(window.innerWidth * 0.92, 960)
  return (
    <dialog
      ref={ref}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      className="m-auto rounded-lg border border-paper-line bg-paper p-0 shadow-xl backdrop:bg-ink/70"
    >
      <div className="flex items-center justify-between gap-4 border-b border-paper-line px-4 py-2">
        <span className="meta-label">Frame · {formatClock(frame.time)}</span>
        <button type="button" className="pill-ghost" onClick={onClose} aria-label="Close frame view">
          ✕
        </button>
      </div>
      <div className="overflow-hidden bg-ink" style={spriteStyle(frame, width)} />
    </dialog>
  )
}

function Pane({
  label,
  sublabel,
  words,
  secondsPerLine,
  segmentSeconds,
  cuts,
  overlaps = [],
  minSeconds,
  windowStart,
  windowEnd,
  segments,
  controls,
  edit,
  rowHeight,
  onPlayFrom,
  playheadSec,
  onCollapse,
  headerExtra,
}: PaneProps) {
  const lines = useMemo(
    () =>
      windowLines(
        buildTranscriptGrid(words, secondsPerLine, segmentSeconds, minSeconds),
        windowStart,
        windowEnd,
        secondsPerLine,
      ),
    [words, secondsPerLine, segmentSeconds, minSeconds, windowStart, windowEnd],
  )
  const cols = segmentsPerLine(secondsPerLine, segmentSeconds)
  // cells per whole second — used to draw separators only on second boundaries
  const perSecond = Math.max(1, Math.round(1 / segmentSeconds))

  // Which row each narration run's control lands on (its segment start).
  const segByRow = useMemo(() => {
    const m = new Map<number, SegmentControl>()
    for (const s of segments) m.set(Math.floor(Math.max(0, s.start) / secondsPerLine), s)
    return m
  }, [segments, secondsPerLine])

  // The New pane paints a green span for each VOICED run — from its start across
  // the clip's real measured length — so you can see where the audio ends.
  const voiced = useMemo<CutSpan[]>(
    () =>
      controls
        ? segments
            .filter((s) => s.audioSeconds && s.audioSeconds > 0)
            .map((s) => ({ start: s.start, end: s.start + (s.audioSeconds as number) }))
        : [],
    [controls, segments],
  )

  // gutter (timestamp) + one equal column per time slice
  const template = `3.5rem repeat(${cols}, minmax(0, 1fr))`

  // Which row + cell the audio playhead sits in — the row lights up and the
  // exact cell being spoken gets a stronger highlight that walks the grid.
  const playPos =
    playheadSec != null ? gridPosition(playheadSec, secondsPerLine, segmentSeconds) : null

  return (
    <div className="bg-paper">
      <div className="flex items-baseline gap-2 px-4 py-2.5">
        <span className="font-serif text-[15px] text-ink">{label}</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {sublabel}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {headerExtra}
          {overlaps.length > 0 && (
            <span className="font-mono text-[11px] text-amber-700">
              ⚠ {overlaps.length} overlap{overlaps.length === 1 ? '' : 's'} to resolve — drag a run off
            </span>
          )}
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title={`Hide the ${label} pane`}
              aria-label={`Hide the ${label} pane`}
              className="cursor-pointer font-mono text-[12px] leading-none text-ink-faint transition-colors hover:text-ink"
            >
              ⊟
            </button>
          )}
        </span>
      </div>

      {/* single-line rows; clip horizontally so bleeding words never spill into
          the other pane. The pane flexes to its full height — the page scrolls. */}
      <div className="overflow-x-hidden pb-2 font-mono text-[12px] leading-relaxed">
        {lines.length === 0 ? (
          <p className="px-4 py-3 text-ink-mute">No words yet.</p>
        ) : (
          lines.map((line) => {
            const seg = segByRow.get(line.index)
            return (
              <div key={line.index}>
                {seg &&
                  (controls ? (
                    <SegmentVoiceControl
                      segment={seg}
                      canAI={controls.canAI}
                      onGenerateAI={() => controls.onGenerateAI(seg.sceneId, seg.index)}
                      onRecord={(blob) => controls.onRecord(seg.sceneId, seg.index, blob)}
                      onPlay={controls.onPlay}
                      onDelete={() => controls.onDelete(seg.sceneId, seg.index)}
                      onMoveStart={
                        controls.onMoveStart ? () => controls.onMoveStart?.(seg) : undefined
                      }
                      onUseOriginal={
                        controls.onUseOriginal
                          ? () => controls.onUseOriginal?.(seg.sceneId, seg.index)
                          : undefined
                      }
                      voiceOptions={controls.voiceOptions}
                      onPickVoice={
                        controls.onPickVoice
                          ? (vid) => controls.onPickVoice?.(seg.sceneId, seg.index, vid)
                          : undefined
                      }
                    />
                  ) : (
                    // Spacer on the Original pane so both panes stay row-aligned.
                    <div className="h-9 border-t border-paper-line/60 bg-paper-deep/20" />
                  ))}
                <Row
                  line={line}
                  template={template}
                  perSecond={perSecond}
                  segmentSeconds={segmentSeconds}
                  cuts={cuts}
                  overlaps={overlaps}
                  voiced={voiced}
                  edit={edit}
                  rowHeight={rowHeight}
                  onPlay={onPlayFrom ? () => onPlayFrom(line.startSec) : undefined}
                  playing={playPos?.line === line.index}
                  playingCol={playPos?.line === line.index ? playPos.col : null}
                />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function Row({
  line,
  template,
  perSecond,
  segmentSeconds,
  cuts,
  overlaps,
  voiced,
  edit,
  rowHeight,
  onPlay,
  playing = false,
  playingCol = null,
}: {
  line: GridLine
  template: string
  perSecond: number
  segmentSeconds: number
  cuts: CutSpan[]
  overlaps: CutSpan[]
  voiced: CutSpan[]
  edit: CellEdit | null
  rowHeight: number
  /** Play the original audio from this row's start second (Original pane only). */
  onPlay?: () => void
  /** This row holds the audio playhead — lit up + the timestamp shown active. */
  playing?: boolean
  /** The column the playhead is in (this row only) — that exact cell gets a
   *  stronger highlight that steps cell-by-cell as the audio plays. */
  playingCol?: number | null
}) {
  const cutCols = cutColumns(line.startSec, line.cells.length, segmentSeconds, cuts)
  const overlapCols = cutColumns(line.startSec, line.cells.length, segmentSeconds, overlaps)
  const voicedCols = cutColumns(line.startSec, line.cells.length, segmentSeconds, voiced)
  const previewCols =
    edit?.preview ? cutColumns(line.startSec, line.cells.length, segmentSeconds, [edit.preview]) : []
  const glowCols =
    edit?.glow?.length ? cutColumns(line.startSec, line.cells.length, segmentSeconds, edit.glow) : []

  const mode = edit?.mode
  const draggable = mode === 'cut' || mode === 'select'

  // The footprint preview's fill + outline (place mode); the cut/select previews
  // are outline-only. Keyed off `previewKind` so each gesture reads distinctly.
  const previewClass: Record<NonNullable<CellEdit['previewKind']>, string> = {
    add: 'ring-2 ring-inset ring-terracotta',
    remove: 'ring-2 ring-inset ring-ink-faint',
    select: 'ring-2 ring-inset ring-voice-ink',
    'place-ok': 'bg-voice/40 ring-2 ring-inset ring-voice',
    'place-bad': 'bg-terracotta/30 ring-2 ring-inset ring-terracotta',
  }

  return (
    <div
      className={[
        'grid border-t border-paper-line/60',
        // the row the audio playhead is in lights up as it plays
        playing ? 'bg-terracotta/15' : '',
      ].join(' ')}
      // The row track grows to `rowHeight` (tall-rows mode) and the cells stretch
      // to it; their `items-center` keeps the single line of text centred.
      style={{ gridTemplateColumns: template, gridAutoRows: `minmax(${rowHeight}px, auto)` }}
    >
      {/* line "number" = the row's start timestamp. With `onPlay` it's a button:
          click to play the original audio from this second. Styled to read as the
          plain timestamp it was — the cursor + hover tint are the only "button"
          tells — so the gutter stays quiet. */}
      {onPlay ? (
        <button
          type="button"
          onClick={onPlay}
          title={`Play original from ${formatClock(line.startSec)}`}
          aria-label={`Play original audio from ${formatClock(line.startSec)}`}
          className={[
            // appearance-none strips the native button chrome, but then WebKit
            // falls back to a black UA border on every side — border-0 kills it,
            // and we re-add only the faint right divider to match the plain
            // timestamp it replaced. outline-none drops the click focus box.
            'flex h-full w-full cursor-pointer select-none appearance-none items-center justify-end border-0 border-r border-paper-line/60 bg-transparent px-2 text-[11px] outline-none transition-colors',
            playing ? 'font-semibold text-terracotta' : 'text-ink-faint hover:text-terracotta',
          ].join(' ')}
        >
          {formatClock(line.startSec)}
        </button>
      ) : (
        <div className="flex select-none items-center justify-end border-r border-paper-line/60 px-2 text-[11px] text-ink-faint">
          {formatClock(line.startSec)}
        </div>
      )}

      {line.cells.map((cell, col) => {
        const time = line.startSec + col * segmentSeconds
        return (
          <div
            key={col}
            onPointerDown={
              draggable
                ? (e) => {
                    e.preventDefault() // don't start a text selection while dragging
                    edit?.onCellDown?.(time, cutCols[col], e.shiftKey)
                  }
                : undefined
            }
            onPointerEnter={edit?.onCellEnter ? () => edit.onCellEnter?.(time) : undefined}
            onClick={mode === 'place' ? () => edit?.onCellClick?.(time) : undefined}
            className={[
              'flex min-h-[2rem] items-center px-1',
              draggable ? 'cursor-pointer select-none' : '',
              // any cell takes the drop now (story 03h) — overlap is legal
              mode === 'place' ? 'cursor-pointer select-none' : '',
              // separators only on whole-second boundaries, so quarter-slices stay quiet
              col > 0 && col % perSecond === 0 ? 'border-l border-paper-line/50' : '',
              // conflicting runs amber (the state to resolve), else dropped footage
              // red, else the voiced span green
              overlapCols[col]
                ? 'bg-amber-400/50'
                : cutCols[col]
                  ? 'bg-terracotta/30'
                  : voicedCols[col]
                    ? 'bg-voice/25'
                    : playingCol === col
                      ? 'bg-terracotta/30'
                      : '',
              // the exact cell under the playhead — outlined so it reads on top
              // of any fill (cut red / overlap amber / voiced green) as well
              playingCol === col ? 'ring-2 ring-inset ring-terracotta' : '',
              // place mode: faintly tint the gaps where a drop lands clean
              mode === 'place' && glowCols[col] && !cutCols[col] && !voicedCols[col] ? 'bg-voice/10' : '',
              // the active preview (cut paint / clip grab / drop or move footprint)
              previewCols[col] && edit?.previewKind ? previewClass[edit.previewKind] : '',
            ].join(' ')}
          >
            {/* nowrap + visible overflow: a word sits at its slot and bleeds right
                over the (usually empty) neighbouring slices instead of wrapping. */}
            <span className="whitespace-nowrap text-ink">
              {cell.map((word, i) => (
                <span key={i}>{i > 0 ? ' ' : ''}{word.text}</span>
              ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}
