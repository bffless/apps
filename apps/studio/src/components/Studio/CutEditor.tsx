import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
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
import { claimPlayback } from './clipPlayer'
import { auditionSpan, finalCutSeconds, nextKeptTime } from '../../lib/playback'
import { normalizeCuts } from '../../lib/refiner'
import { noiseSpans, type DeadSpan } from '../../lib/deadSpace'
import { frameForRow, spriteStyle, type FilmFrame } from '../../lib/filmstrip'
import type { SearchHit } from '../../lib/search'

type Props = {
  /** The scene's original transcript words — the ONE text (ADR-0003). */
  words: TWord[]
  /** Footage spans being dropped (refiner's `cuts`, else the director's), in
   *  original-video seconds. Rendered as red cells. */
  cuts?: CutSpan[]
  /** Hand-edit the cuts by dragging on the grid. The drag's start cell decides
   *  the op: starting on kept footage **adds** a cut (drag to size / extend an
   *  adjacent one); starting on a red cell **removes** (contract or split). The
   *  span is in original-video seconds, snapped to whole cells. Omit to make the
   *  grid read-only (the prep previews). */
  onEditCut?: (span: CutSpan, op: 'add' | 'remove') => void
  /** Search the whole talk by meaning (story 08). The page runs the query
   *  through `/api/search-transcript` over the FULL transcript (this editor
   *  only has the scene slice) and resolves hits annotated with the owning
   *  scene's title and the span's transcript `words` — each hit renders as a
   *  read-only time grid windowed to the hit, with a Play button. Omit to hide
   *  the search affordance. */
  onSearch?: (query: string) => Promise<(SearchHit & { sceneTitle?: string; words?: TWord[] })[]>
  /** Contact-sheet frames (story 03e) for the time-aligned filmstrip gutter down
   *  the left of the editor. Empty ⇒ no gutter (e.g. before thumbnails exist). */
  frames?: FilmFrame[]
  /** The source clip's real length, in seconds. The grid is floored to this so
   *  trailing footage with no speech (e.g. the talk ends at 0:50 on a 0:53 clip)
   *  still renders editable rows — otherwise the grid stops at the last word and
   *  that footage can't be seen or cut. */
  duration?: number
  /** Restrict the editor to one scene's window on the absolute timeline (story
   *  03c "per-scene scope"): rows before `windowStart` (floored to the line) and
   *  at/after `windowEnd` aren't rendered, so the grid shows only the selected
   *  `SceneTabs` tab and switching tabs re-scopes it. Timestamps stay absolute —
   *  scene 2 reads from 1:44, matching its footage span. Omit (0 / Infinity) to
   *  show the whole talk. */
  windowStart?: number
  windowEnd?: number
  /** The whole-source extracted audio (16 kHz WAV). When set, each timestamp
   *  becomes a play button: click it to play the FINAL CUT from that second —
   *  the kept spans only, skipping every red cut span (story 13d) — through the
   *  scene's `windowEnd`, with the lit row tracking the playhead across the
   *  skips. Modifier-click plays the raw source straight through cuts. Omit
   *  (prep previews) to keep the gutter read-only. */
  originalAudioUrl?: string
  /** Every scene's effective cuts — the WHOLE project's, not just this scene's —
   *  for the header's live duration readout (`final cut 4:32 · source 12:10`,
   *  story 13d): pure arithmetic, `duration` minus the cut footage. Omit to
   *  hide the readout. */
  projectCuts?: CutSpan[]
  /** The Build page's `<video>`, so stitched playback carries the picture too:
   *  while the transport plays, the video is muted (the WAV stays the
   *  soundtrack) and kept in sync — including across cut skips — then released
   *  (paused, muted restored) when playback stops. `offset` maps absolute
   *  source seconds onto the element's own timeline (a sliced scene clip
   *  starts at `scene.start`; the full source is 0). */
  video?: { ref: RefObject<HTMLVideoElement | null>; offset: number }
  /** Measured dead space (story 13c): spans of true silence in the extracted
   *  WAV, in original-video seconds. When set, wordless cells split into two
   *  states — **dead space** (inside a span — dimmed, prime cut territory) and
   *  **noise** (energy but no words — a breath/click marker), with cuts red on
   *  top of either. Omit (not yet measured) for the flat two-state grid. */
  deadSpace?: DeadSpan[]
}

/** An in-progress cut drag: the cell it began on, the cell under the pointer
 *  now, and the op fixed at pointer-down. */
type Drag = { start: number; end: number; op: 'add' | 'remove' }

/** Last second any of these words occupies (0 if none / untimed). */
function lastSecond(words: TWord[]): number {
  let max = 0
  for (const w of words) {
    const t = typeof w.end === 'number' ? w.end : typeof w.start === 'number' ? w.start : 0
    if (t > max) max = t
  }
  return max
}

/**
 * The cut editor — the Build screen's one grid (ADR-0003). The original
 * transcript on a time grid: line numbers are timestamps; each row is
 * `secondsPerLine` seconds sliced into `segmentSeconds` cells. Dropped footage
 * (`cuts`) is filled red; empty cells are the dead space; drag to cut/un-cut.
 * A filmstrip gutter keeps the picture in view, and clicking a timestamp plays
 * the FINAL CUT from that second — kept spans only, cuts skipped in both audio
 * and the synced video (story 13d); modifier-click plays the raw source. Each
 * cut carries an audition button that replays its seam. Edits never auto-play.
 */
export function CutEditor({
  words,
  cuts = [],
  onEditCut,
  onSearch,
  frames = [],
  duration = 0,
  windowStart = 0,
  windowEnd = Infinity,
  originalAudioUrl,
  projectCuts,
  video,
  deadSpace,
}: Props) {
  const [secondsPerLine, setSecondsPerLine] = useState(DEFAULT_SECONDS_PER_LINE)
  const [segmentSeconds, setSegmentSeconds] = useState(DEFAULT_SEGMENT_SECONDS)
  // Tall-rows mode: grow EVERY row to a full frame's height so the filmstrip
  // shows whole frames (not just the centred band) while staying aligned to the
  // words. Default on; toggle off for compact rows + hover-to-peek.
  const [tallRows, setTallRows] = useState(true)

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

  const edit: CellEdit | null = editable
    ? { onCellDown, onCellEnter, preview: cutPending, previewKind: drag?.op ?? null }
    : null

  // Transcript search (story 08): `searchOpen` shows the query bar; hits are
  // transient — closing the bar clears them. Each hit renders as a full-width
  // read-only Pane windowed to the hit, with a Play button.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchHits, setSearchHits] = useState<
    (SearchHit & { sceneTitle?: string; words?: TWord[] })[] | null
  >(null)

  // Playback from a clicked timestamp (story 13d): the transport plays the
  // whole-source WAV, and by default it plays THE FINAL CUT — on every tick the
  // playhead is bumped past any red span with `nextKeptTime`, so cuts are
  // skipped and the lit row tracks the grid across the skips. 'raw' mode
  // (modifier-click, search hits) plays the source straight through.
  // `playheadSec` lights the row the playhead is in; clicking the row that's
  // currently playing pauses it.
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playheadSec, setPlayheadSec] = useState<number | null>(null)
  const [playMode, setPlayMode] = useState<'stitched' | 'raw'>('stitched')
  // Stop-bound override (story 08 + auditions): search-hit playback ends at the
  // HIT's end, an audition at its padded span's end — not the scene window.
  // Null = the default window bound.
  const [stopAt, setStopAt] = useState<number | null>(null)

  // While the transport plays, the Build page's <video> mirrors it — muted (the
  // WAV is the soundtrack), seeked alongside every skip, released on stop. The
  // element's pre-drive muted state is remembered here so release restores it;
  // null = not currently driving. The driving itself lives in the transport
  // effect below, keyed off the audio element's own play/timeupdate/pause
  // events.
  const videoWasMuted = useRef<boolean | null>(null)

  // Stop the transport when the synced video swaps or the editor unmounts — a
  // detached <audio> keeps sounding otherwise, and the driven video would stay
  // muted with no transport attached.
  useEffect(() => {
    const el = audioRef.current
    const v = video?.ref.current
    return () => {
      el?.pause()
      if (v && videoWasMuted.current != null) {
        v.pause()
        v.muted = videoWasMuted.current
        videoWasMuted.current = null
      }
    }
  }, [video])

  /**
   * The one way anything starts playing. `toggleEnd`: clicking while the
   * playhead is inside `[startSec, toggleEnd)` pauses instead (rows pass their
   * own span; auditions pass an empty window so re-triggering replays the
   * seam). `stopSec` overrides the scene-window stop bound. In 'stitched' mode
   * the start itself is resolved to the first kept moment — red spans never
   * play.
   */
  const transportPlay = useCallback(
    (startSec: number, toggleEnd: number, stopSec: number | null, mode: 'stitched' | 'raw') => {
      const el = audioRef.current
      if (!el) return
      if (!el.paused && playheadSec != null && playheadSec >= startSec && playheadSec < toggleEnd) {
        el.pause()
        return
      }
      const begin = mode === 'stitched' ? nextKeptTime(cuts, startSec) : startSec
      const limit = stopSec ?? windowEnd
      if (begin >= limit) return // everything from here to the bound is cut
      setPlayMode(mode)
      setStopAt(stopSec)
      claimPlayback(el)
      setPlayheadSec(begin) // light the row immediately, before the first timeupdate
      const start = () => {
        el.currentTime = begin
        void el.play().catch(() => {})
      }
      // `preload="metadata"` may not be ready on the first click — seek once the
      // element knows its duration, else `currentTime` is dropped and it plays
      // from 0 (lighting the wrong row).
      if (el.readyState >= 1) start()
      else el.addEventListener('loadedmetadata', start, { once: true })
    },
    [playheadSec, cuts, windowEnd],
  )

  // A grid timestamp: play the final cut from that row — or the raw source
  // when the click carried a modifier.
  const playRow = useCallback(
    (startSec: number, raw: boolean) =>
      transportPlay(startSec, startSec + secondsPerLine, null, raw ? 'raw' : 'stitched'),
    [transportPlay, secondsPerLine],
  )

  // Search hits (story 08) play the RAW source: a hit may live in another
  // scene, whose cuts this editor doesn't hold.
  const playSpan = useCallback(
    (startSec: number, endSec: number) => transportPlay(startSec, endSec, endSec, 'raw'),
    [transportPlay],
  )

  // Audition a cut (story 13d, the edit-listen loop): play ~1.5s of kept
  // footage into the cut, skip it, and ~1.5s out the other side. No toggle —
  // triggering it again replays the seam.
  const audition = useCallback(
    (cut: CutSpan) => {
      const span = auditionSpan(cut, windowStart, windowEnd)
      transportPlay(span.start, span.start, span.end, 'stitched')
    },
    [transportPlay, windowStart, windowEnd],
  )

  const stop = useCallback(() => audioRef.current?.pause(), [])

  // Track the playhead → lit row; in stitched mode jump it past any cut it
  // lands in (live — mid-play edits reroute the very next tick); stop at the
  // scene's end so it doesn't bleed into the next scene's audio. Clearing the
  // lit row is driven by the element's own pause/ended events (not
  // setState-in-effect), so a scene switch that just pauses the audio also
  // clears the highlight — and releases the synced video.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const v = video?.ref.current ?? null

    // Mirror the transport on the synced video: muted (the WAV is the
    // soundtrack), reseeked only on real drift so routine ticks don't stutter
    // the picture.
    const drive = (t: number) => {
      if (!v || !video) return
      if (videoWasMuted.current == null) {
        videoWasMuted.current = v.muted
        v.muted = true
      }
      const target = t - video.offset
      // A scene clip doesn't contain footage outside its window (e.g. a raw
      // search hit from another scene) — leave the picture alone there.
      if (target < 0 || (v.duration > 0 && target > v.duration)) return
      if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target
      if (v.paused) void v.play().catch(() => {})
    }
    const release = () => {
      if (!v || videoWasMuted.current == null) return
      v.pause()
      v.muted = videoWasMuted.current
      videoWasMuted.current = null
    }

    const onPlay = () => drive(el.currentTime)
    const onTime = () => {
      const limit = stopAt ?? windowEnd
      let t = el.currentTime
      if (playMode === 'stitched') {
        const kept = nextKeptTime(cuts, t)
        if (kept > t) {
          if (kept >= limit) {
            el.pause() // the rest of the window is cut — the stitched result ends here
            return
          }
          el.currentTime = kept
          t = kept
        }
      }
      if (Number.isFinite(limit) && t >= limit) {
        el.pause()
        return
      }
      setPlayheadSec(t)
      drive(t)
    }
    const clear = () => {
      setPlayheadSec(null)
      release()
    }
    el.addEventListener('play', onPlay)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('pause', clear)
    el.addEventListener('ended', clear)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('pause', clear)
      el.removeEventListener('ended', clear)
    }
  }, [windowEnd, stopAt, playMode, cuts, video])

  // Switching scenes (or swapping the source) stops playback — the resulting
  // `pause` event clears the lit row — so audio never carries over from the
  // scene you just left.
  useEffect(() => {
    audioRef.current?.pause()
  }, [windowStart, windowEnd, originalAudioUrl])

  // The grid's span: the latest of the transcript, any cut, or the clip's real
  // `duration`, so trailing footage with no words/cuts (the talk ends before the
  // clip does) still renders editable rows. When scoped to a scene, the floor is
  // the scene's `windowEnd` (its footage runs there even past the last word),
  // not the whole-clip `duration`.
  const span = useMemo(() => {
    const cutEnd = cuts.reduce((m, c) => Math.max(m, c.end), 0)
    const words_ = Math.max(lastSecond(words), cutEnd)
    return Number.isFinite(windowEnd) ? Math.max(words_, windowEnd) : Math.max(words_, duration)
  }, [words, cuts, duration, windowEnd])

  // A full frame's display height at the gutter width (its real aspect, so it's
  // not letterboxed). The tall-rows toggle grows every row to this; otherwise
  // rows stay at the compact band height.
  const fullRowHeight = useMemo(() => {
    const f = frames[0]
    if (!f?.sheet.cellWidth) return FILMSTRIP_ROW
    return Math.round(f.sheet.cellHeight * (FILMSTRIP_WIDTH / f.sheet.cellWidth))
  }, [frames])
  const rowHeight = tallRows ? fullRowHeight : FILMSTRIP_ROW

  // The third cell state (story 13c): with dead space measured, whatever is
  // neither spoken nor silent has sound but no words — a breath, a click. The
  // complement is a handful of spans, so each row reuses the same span→columns
  // mapping cuts use instead of re-scanning every word per cell.
  const noise = useMemo(
    () => (deadSpace ? noiseSpans(words, deadSpace, span) : []),
    [deadSpace, words, span],
  )

  // Live duration readout (story 13d): how long the final cut runs vs the
  // source — pure arithmetic over the whole project's effective cuts, updated
  // on every drag-edit as the cuts flow back down.
  const finalCutSec = useMemo(
    () => (projectCuts && duration > 0 ? finalCutSeconds(projectCuts, duration) : null),
    [projectCuts, duration],
  )

  // Each cut gets one audition button, parked on its first cell — normalize so
  // touching/overlapping spans read as the single edit they are.
  const auditionCuts = useMemo(
    () => (originalAudioUrl ? normalizeCuts(cuts) : []),
    [originalAudioUrl, cuts],
  )

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
            {deadSpace ? <>dimmed = dead space · “·” = noise</> : <>blank = dead space</>}
            {editable && ' · drag empty cells to cut, drag red cells to un-cut'}
            {originalAudioUrl && ' · timestamps play the final cut — modifier-click for the raw source'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 font-mono text-[12px] text-ink-mute">
          {finalCutSec != null && (
            <span className="whitespace-nowrap">
              final cut <span className="font-semibold text-terracotta-ink">{formatClock(finalCutSec)}</span>
              {' · '}source <span className="text-ink">{formatClock(duration)}</span>
            </span>
          )}
          {onSearch && !searchOpen && (
            <button
              type="button"
              className="border rule bg-paper px-2 py-1 text-ink transition-colors hover:bg-paper-deep/40"
              onClick={() => setSearchOpen(true)}
            >
              ⌕ Search
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

      {searchOpen && (
        // Transcript search (story 08): query bar + results. Hits are whole-talk;
        // Play previews the span's original audio.
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
            // Result SETS: each hit is the same time grid, windowed to the hit's
            // span and spanning the full editor width. Capped tall; the list
            // scrolls.
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
                      edit={null}
                      rowHeight={FILMSTRIP_ROW}
                      onPlayFrom={
                        originalAudioUrl ? (sec) => playSpan(sec, hit.end) : undefined
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

      {/* "Now playing" cue — sticky (parked under the scene tabs) so the Stop
          control is reachable no matter how far the scene has scrolled. Tracks
          the playhead second; Stop pauses (which clears the lit row via the
          element's pause event). */}
      {playheadSec != null && (
        <div className="sticky top-[var(--diff-sticky-top,3.5rem)] z-20 flex items-center gap-3 border-b rule bg-terracotta/15 px-5 py-2 text-[12.5px] text-ink-soft backdrop-blur">
          <span className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-terracotta" />
            Playing {playMode === 'stitched' ? 'the final cut — skipping cuts' : 'the raw source'} ·{' '}
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
        {/* story 03e: a time-aligned frame gutter, left of the words. It mirrors
            the grid's row structure so it stays in lockstep at any zoom. Only
            meaningful in the lg side-by-side layout. */}
        {frames.length > 0 && (
          <div className="hidden shrink-0 border-r rule lg:block" style={{ width: FILMSTRIP_WIDTH }}>
            <Filmstrip
              words={words}
              secondsPerLine={secondsPerLine}
              segmentSeconds={segmentSeconds}
              minSeconds={span}
              windowStart={windowStart}
              windowEnd={windowEnd}
              frames={frames}
              rowHeight={rowHeight}
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <Pane
            label="Words"
            sublabel="original speech · cuts in red"
            words={words}
            secondsPerLine={secondsPerLine}
            segmentSeconds={segmentSeconds}
            cuts={cuts}
            deadSpans={deadSpace ?? null}
            noise={noise}
            minSeconds={span}
            windowStart={windowStart}
            windowEnd={windowEnd}
            edit={edit}
            rowHeight={rowHeight}
            onPlayFrom={originalAudioUrl ? playRow : undefined}
            stitched
            auditionCuts={auditionCuts}
            onAudition={originalAudioUrl ? audition : undefined}
            playheadSec={playheadSec}
          />
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
 * Per-cell interaction handed to a pane — cut mode only (ADR-0003): pointer-drag
 * to add/remove cuts; `preview` outlines the span being painted.
 */
type CellEdit = {
  onCellDown: (time: number, isCut: boolean) => void
  onCellEnter: (time: number) => void
  /** The cut being painted, outlined as you drag. */
  preview: CutSpan | null
  previewKind: 'add' | 'remove' | null
}

type PaneProps = {
  label: string
  sublabel: string
  words: TWord[]
  secondsPerLine: number
  segmentSeconds: number
  cuts: CutSpan[]
  /** Measured dead-space spans (story 13c). Null = not measured — wordless
   *  cells render flat instead of splitting into dead/noise. */
  deadSpans?: DeadSpan[] | null
  /** The energy-but-no-words complement (see `noiseSpans`), precomputed once by
   *  the editor. Ignored while `deadSpans` is null. */
  noise?: DeadSpan[]
  minSeconds: number
  /** Scene window on the absolute timeline — rows outside it are cropped so the
   *  pane shows only the selected scene (story 03c). 0 / Infinity ⇒ whole talk. */
  windowStart: number
  windowEnd: number
  edit: CellEdit | null
  /** Minimum height (px) for each grid row — the tall-rows toggle drives this so
   *  the rows grow in lockstep with the filmstrip's full-frame cells. */
  rowHeight: number
  /** When set, each row's timestamp becomes a play button (start that second).
   *  `raw` is true when the click carried a modifier — play the source straight
   *  through cuts instead of the stitched result. */
  onPlayFrom?: (startSec: number, raw: boolean) => void
  /** Whether timestamp playback is the stitched final cut (the main grid) or
   *  the raw source (search-hit sets) — drives the button's hover hint only. */
  stitched?: boolean
  /** Normalized cut spans, each of which gets a keyboard-reachable audition
   *  button on its first cell (story 13d). Requires `onAudition`. */
  auditionCuts?: CutSpan[]
  /** Audition one cut: play ~1.5s before it through ~1.5s after, skipping the
   *  cut itself — the edit-listen loop. */
  onAudition?: (cut: CutSpan) => void
  /** The audio playhead, in absolute seconds — the row containing it lights up.
   *  null when nothing is playing. */
  playheadSec?: number | null
  /** Extra header content, right-aligned (search sets: the hit's reason + Play). */
  headerExtra?: ReactNode
}

/**
 * The 03e filmstrip gutter — a frame for each grid row, down the left of the
 * editor. It runs the SAME `buildTranscriptGrid` mapping as the words pane, so
 * it stays aligned to the timestamps row-for-row at any zoom. Each row shows
 * the contact-sheet frame nearest its start second, sprite-cropped from its
 * sheet (no new image generation).
 */
function Filmstrip({
  words,
  secondsPerLine,
  segmentSeconds,
  minSeconds,
  windowStart,
  windowEnd,
  frames,
  rowHeight,
}: {
  words: TWord[]
  secondsPerLine: number
  segmentSeconds: number
  minSeconds: number
  windowStart: number
  windowEnd: number
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

  // Click a thumbnail to inspect it full-size (the strip is only 150px wide).
  const [zoomFrame, setZoomFrame] = useState<FilmFrame | null>(null)

  return (
    <div className="bg-paper">
      {/* header height matches the Pane header so row 0 aligns across the columns */}
      <div className="flex items-baseline gap-2 px-4 py-2.5">
        <span className="font-serif text-[15px] text-ink">Frames</span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">video</span>
      </div>
      <div className="pb-2">
        {lines.map((line) => {
          const frame = frameForRow(frames, line.startSec)
          return (
            <div key={line.index}>
              {/* Divider on the wrapper (outside the sized box) mirrors the Pane
                  Row's border placement, so the gutter and the words stay exactly
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
  deadSpans = null,
  noise = [],
  minSeconds,
  windowStart,
  windowEnd,
  edit,
  rowHeight,
  onPlayFrom,
  stitched = false,
  auditionCuts = [],
  onAudition,
  playheadSec,
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
        <span className="ml-auto flex items-center gap-3">{headerExtra}</span>
      </div>

      {/* single-line rows; clip horizontally so bleeding words never spill out
          of the pane. The pane flexes to its full height — the page scrolls. */}
      <div className="overflow-x-hidden pb-2 font-mono text-[12px] leading-relaxed">
        {lines.length === 0 ? (
          <p className="px-4 py-3 text-ink-mute">No words yet.</p>
        ) : (
          lines.map((line) => (
            <Row
              key={line.index}
              line={line}
              template={template}
              perSecond={perSecond}
              segmentSeconds={segmentSeconds}
              cuts={cuts}
              deadSpans={deadSpans}
              noise={noise}
              edit={edit}
              rowHeight={rowHeight}
              onPlay={onPlayFrom ? (raw) => onPlayFrom(line.startSec, raw) : undefined}
              stitched={stitched}
              auditionCuts={auditionCuts}
              onAudition={onAudition}
              playing={playPos?.line === line.index}
              playingCol={playPos?.line === line.index ? playPos.col : null}
            />
          ))
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
  deadSpans = null,
  noise = [],
  edit,
  rowHeight,
  onPlay,
  stitched = false,
  auditionCuts = [],
  onAudition,
  playing = false,
  playingCol = null,
}: {
  line: GridLine
  template: string
  perSecond: number
  segmentSeconds: number
  cuts: CutSpan[]
  /** Measured dead space / noise spans (story 13c) — see PaneProps. */
  deadSpans?: DeadSpan[] | null
  noise?: DeadSpan[]
  edit: CellEdit | null
  rowHeight: number
  /** Play from this row's start second; `raw` = the click carried a modifier. */
  onPlay?: (raw: boolean) => void
  /** See PaneProps — stitched-vs-raw hover hint, audition buttons. */
  stitched?: boolean
  auditionCuts?: CutSpan[]
  onAudition?: (cut: CutSpan) => void
  /** This row holds the audio playhead — lit up + the timestamp shown active. */
  playing?: boolean
  /** The column the playhead is in (this row only) — that exact cell gets a
   *  stronger highlight that steps cell-by-cell as the audio plays. */
  playingCol?: number | null
}) {
  const cutCols = cutColumns(line.startSec, line.cells.length, segmentSeconds, cuts)
  const previewCols =
    edit?.preview ? cutColumns(line.startSec, line.cells.length, segmentSeconds, [edit.preview]) : []
  // Three-state cells (story 13c): dead space and noise reuse the same
  // span→columns mapping as cuts. Null (unmeasured) keeps the flat grid.
  const deadCols = deadSpans
    ? cutColumns(line.startSec, line.cells.length, segmentSeconds, deadSpans)
    : null
  const noiseCols = deadSpans
    ? cutColumns(line.startSec, line.cells.length, segmentSeconds, noise)
    : null

  // The cut/un-cut paint previews are outline-only, keyed off `previewKind` so
  // each gesture reads distinctly.
  const previewClass: Record<NonNullable<CellEdit['previewKind']>, string> = {
    add: 'ring-2 ring-inset ring-terracotta',
    remove: 'ring-2 ring-inset ring-ink-faint',
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
          onClick={(e) => onPlay(e.altKey || e.metaKey || e.ctrlKey || e.shiftKey)}
          title={
            stitched
              ? `Play the final cut from ${formatClock(line.startSec)} — modifier-click for the raw source`
              : `Play original from ${formatClock(line.startSec)}`
          }
          aria-label={`Play from ${formatClock(line.startSec)}`}
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
        // A cut that BEGINS in this cell's slot carries the audition button —
        // one per cut, on its first cell (the seam being judged).
        const auditionHere = onAudition
          ? auditionCuts.find((c) => c.start >= time && c.start < time + segmentSeconds)
          : undefined
        return (
          <div
            key={col}
            onPointerDown={
              edit
                ? (e) => {
                    e.preventDefault() // don't start a text selection while dragging
                    edit.onCellDown(time, cutCols[col])
                  }
                : undefined
            }
            onPointerEnter={edit ? () => edit.onCellEnter(time) : undefined}
            className={[
              'relative flex min-h-[2rem] items-center px-1',
              edit ? 'cursor-pointer select-none' : '',
              // separators only on whole-second boundaries, so quarter-slices stay quiet
              col > 0 && col % perSecond === 0 ? 'border-l border-paper-line/50' : '',
              // dropped footage red (on top of any measured state); the exact
              // playhead cell tinted; then measured dead space dims WORDLESS
              // cells — true silence, the prime territory for a cut.
              cutCols[col]
                ? 'bg-terracotta/30'
                : playingCol === col
                  ? 'bg-terracotta/30'
                  : deadCols?.[col] && cell.length === 0
                    ? 'bg-paper-deep/70'
                    : '',
              // the exact cell under the playhead — outlined so it reads on top
              // of a cut's red fill as well
              playingCol === col ? 'ring-2 ring-inset ring-terracotta' : '',
              // the active cut/un-cut paint preview
              previewCols[col] && edit?.previewKind ? previewClass[edit.previewKind] : '',
            ].join(' ')}
          >
            {auditionHere && (
              // Audition the edit (story 13d): a real, tabbable button on the
              // cut's first cell — Enter replays the seam. pointerdown must not
              // bubble, or pressing it would start an un-cut drag.
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onAudition?.(auditionHere)}
                title="Audition this edit — plays 1.5s before the cut through 1.5s after"
                aria-label={`Audition the cut at ${formatClock(auditionHere.start)}`}
                className="absolute -left-2 top-1/2 z-10 flex h-4 w-4 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-terracotta bg-paper text-[10px] leading-none text-terracotta-ink transition-colors hover:bg-terracotta hover:text-paper"
              >
                ⟲
              </button>
            )}
            {/* nowrap + visible overflow: a word sits at its slot and bleeds right
                over the (usually empty) neighbouring slices instead of wrapping. */}
            <span className="whitespace-nowrap text-ink">
              {cell.length === 0 && noiseCols?.[col] ? (
                // Noise (story 13c): sound with no words — a breath, a click. A
                // quiet dot, because it may not cut as cleanly as true silence.
                <span aria-hidden className="text-ink-faint">·</span>
              ) : (
                cell.map((word, i) => (
                  <span key={i}>{i > 0 ? ' ' : ''}{word.text}</span>
                ))
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
