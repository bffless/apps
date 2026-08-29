/**
 * `cut-editor` — the `trim` step's island (`studio.workflow.yaml`).
 *
 * The one step where a person edits the machine's work. The refiner has proposed
 * `cuts` for this scene; the island renders them on **Studio's own `CutEditor`** — the
 * same grid the Studio app uses, imported through the `studio` workspace package
 * rather than forked — over the scene's cut clip, the SOURCE's extracted WAV and the
 * source's contact sheets. **Done** submits two outputs:
 *
 * - `cuts` — the normalised cuts, in the SOURCE's seconds (what the grid deals in).
 * - `keep` — their complement inside the scene, shifted into CLIP time. This is the
 *   one `assemble` consumes (`video/slice` over `steps.cut.outputs.clip`).
 *
 * Headless (`hostContext.bffless.headless`): there is nobody to look at any of it, so
 * the refiner's cuts are submitted at once — before, and independently of, signing.
 * An unattended run must never be stopped by a presign failure, nor by a refiner that
 * cut the whole scene: that submits the WHOLE scene instead of an empty `keep`, which
 * `video/slice` would refuse and which would otherwise hang the run until its timeout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CutEditor } from 'studio/components/Studio/CutEditor'
import { addCut, normalizeCuts, removeCut } from 'studio/lib/refiner'
import { formatClock, type CutSpan, type TWord } from 'studio/lib/transcriptGrid'
import type { Cut } from 'studio/lib/scenes'
import { framesFor, measureSheet, type SheetImage } from './filmstrip'
import { keepForClip, type SceneWindow } from './keep'
import {
  failureText,
  resultText,
  useSigned,
  type FileRef,
  type IslandBridge,
} from './useSigned'

// ---------------------------------------------------------------------------
// The step's `with`, narrowed
//
// `ui/notifications/tool-input` delivers whatever the harness evaluated — the step's
// `with` minus `src`/`title`/`display`. It is JSON off a live run, so every field is
// narrowed rather than cast: a scene the director wrote without an `end`, or a
// `sheets`/`times` pair that fell out of step, must degrade to a usable editor, not a
// blank frame.
// ---------------------------------------------------------------------------

interface TrimInput {
  /** The scene's own cut clip — its timeline starts at 0, i.e. at `scene.start`. */
  clip: FileRef | null
  /**
   * The SOURCE's extracted audio, NOT the clip's (R142). `CutEditor`'s transport seeks
   * this element in original-source seconds with no offset (`windowStart` only bounds
   * the grid), so a scene starting at 1:40 seeks to 1:40 — which on a clip's own WAV is
   * past the end, and plays silence. The workflow feeds
   * `needs.per-video.outputs.wav[sourceIndex]`.
   */
  wav: FileRef | null
  scene: SceneWindow & { title: string }
  words: TWord[]
  cuts: Cut[]
  sheets: FileRef[]
  /**
   * One array of capture seconds per sheet, parallel to `sheets` (R118). Both may be
   * absent (`null`) or empty: a recording with no spoken audio plans no captures, so
   * the workflow skips its contact-sheet step and this scene's `sheets`/`times` arrive
   * null (R147). The editor renders the grid with no filmstrip gutter.
   */
  times: number[][]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

function asRef(value: unknown): FileRef | null {
  if (!isRecord(value) || typeof value.path !== 'string' || value.path === '') return null
  return {
    path: value.path,
    name: typeof value.name === 'string' ? value.name : undefined,
    contentType: typeof value.contentType === 'string' ? value.contentType : undefined,
  }
}

function asSpans(value: unknown): Cut[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((span) => ({ start: num(span.start), end: num(span.end) }))
    .filter((span) => span.end > span.start)
}

function asWords(value: unknown): TWord[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((word) => ({
    text: typeof word.text === 'string' ? word.text : '',
    start: num(word.start),
    end: num(word.end, num(word.start)),
    speaker: typeof word.speaker === 'string' ? word.speaker : undefined,
  }))
}

function asTimes(value: unknown): number[][] {
  if (!Array.isArray(value)) return []
  return value.map((row) => (Array.isArray(row) ? row.map((time) => num(time)) : []))
}

/** The scene row the director produced — `start`/`end` on its source's timeline. */
function asScene(value: unknown, words: TWord[]): SceneWindow & { title: string } {
  const scene = isRecord(value) ? value : {}
  const start = num(scene.start)
  // A scene with no usable `end` still has to render: fall back to the last word.
  const lastWord = words.reduce((max, word) => Math.max(max, word.end, word.start), start)
  const end = Math.max(start, num(scene.end, lastWord))
  return { start, end, title: typeof scene.title === 'string' ? scene.title : '' }
}

export function parseArgs(args: Record<string, unknown>): TrimInput {
  const words = asWords(args.words)
  return {
    clip: asRef(args.clip),
    wav: asRef(args.wav),
    scene: asScene(args.scene, words),
    words,
    cuts: normalizeCuts(asSpans(args.cuts)),
    sheets: Array.isArray(args.sheets) ? args.sheets.map(asRef).filter((r) => r !== null) : [],
    times: asTimes(args.times),
  }
}

/** A stable empty list, so `frames` doesn't re-memo on every render before measuring. */
const NO_SHEETS: SheetImage[] = []

/** True on an unattended run (spec 07): the harness sets it in the host context. */
function isHeadless(bridge: IslandBridge): boolean {
  const context = bridge.getHostContext()
  if (!isRecord(context) || !isRecord(context.bffless)) return false
  return context.bffless.headless === true
}

// ---------------------------------------------------------------------------

export interface EditorProps {
  /** The `arguments` of `ui/notifications/tool-input`. */
  args: Record<string, unknown>
  bridge: IslandBridge
}

export function Editor({ args, bridge }: EditorProps): React.JSX.Element {
  const input = useMemo(() => parseArgs(args), [args])
  const { clip, wav, scene, words, sheets, times } = input

  const headless = isHeadless(bridge)

  // The editable state: the refiner's cuts to start with, then whatever the member
  // paints on the grid. Deliberately seeded once — a re-delivered `tool-input` (a
  // reconnect, a retry) must not throw away edits made since the first one.
  const [cuts, setCuts] = useState<Cut[]>(input.cuts)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [sending, setSending] = useState(false)

  const paths = useMemo(
    () =>
      [clip?.path, wav?.path, ...sheets.map((sheet) => sheet.path)].filter(
        (path): path is string => !!path,
      ),
    [clip, wav, sheets],
  )
  const { urls, error: signError } = useSigned(bridge, paths, !headless)

  const clipUrl = clip ? urls[clip.path] : undefined
  const wavUrl = wav ? urls[wav.path] : undefined

  // The sheets that signed, paired with their capture times. A sheet whose `times`
  // never arrived contributes no frames, so it is dropped rather than measured.
  const signedSheets = useMemo(
    () =>
      sheets
        .map((sheet, i) => ({ url: urls[sheet.path], times: times[i] ?? [] }))
        .filter(
          (sheet): sheet is { url: string; times: number[] } =>
            !!sheet.url && sheet.times.length > 0,
        ),
    [sheets, times, urls],
  )

  // Each sheet's pixel size — the sprite geometry `CutEditor` crops cells with. One
  // `Image` load per sheet; a sheet that won't load costs its own frames only. Stored
  // against the sheet list it was measured for (as `useSigned` does), so a new set of
  // sheets reads as "not measured yet" without an effect resetting it.
  const sheetKey = useMemo(() => signedSheets.map((sheet) => sheet.url).join('\n'), [signedSheets])
  const [measured, setMeasured] = useState<{ key: string; sheets: SheetImage[] } | null>(null)
  useEffect(() => {
    if (signedSheets.length === 0) return
    let cancelled = false
    void Promise.all(
      signedSheets.map(async (sheet): Promise<SheetImage | null> => {
        try {
          const { width, height } = await measureSheet(sheet.url)
          return { url: sheet.url, times: sheet.times, width, height }
        } catch {
          return null
        }
      }),
    ).then((loaded) => {
      if (!cancelled) setMeasured({ key: sheetKey, sheets: loaded.filter((s) => s !== null) })
    })
    return () => {
      cancelled = true
    }
  }, [signedSheets, sheetKey])

  const sheetImages = measured?.key === sheetKey ? measured.sheets : NO_SHEETS

  const frames = useMemo(() => framesFor(sheetImages), [sheetImages])

  // The clip element the editor drives: while the source-WAV transport plays, `CutEditor`
  // mutes this, seeks it across every cut skip, and releases it on stop. `offset` maps
  // source seconds onto the clip's own timeline, which starts at the scene.
  const videoRef = useRef<HTMLVideoElement>(null)
  const video = useMemo(() => ({ ref: videoRef, offset: scene.start }), [scene.start])

  // A drag on the grid, routed through Studio's own cut algebra (the same two calls
  // the Studio page's `editSceneCut` makes).
  const onEditCut = useCallback(
    (span: CutSpan, op: 'add' | 'remove') => {
      setCuts((prev) => (op === 'add' ? addCut(prev, span, scene) : removeCut(prev, span)))
    },
    [scene],
  )

  // `keep` is the output `assemble` actually consumes, and `video/slice` refuses an empty
  // span list — so a scene that has been cut end to end has nothing to submit. Computed
  // from the LIVE cuts, so the button comes back the moment a span is released.
  const nothingKept = useMemo(() => keepForClip(cuts, scene).length === 0, [cuts, scene])

  const submit = useCallback(
    async (spans: Cut[]) => {
      setSending(true)
      try {
        const outputs = { cuts: normalizeCuts(spans), keep: keepForClip(spans, scene) }
        const result = await bridge.callServerTool({
          name: 'workflow.submit',
          arguments: { outputs },
        })
        // A refused submit comes back as a tool ERROR, not a throw, and the step stays
        // waiting — so it is shown and the button stays live for another go.
        if (result.isError) setSubmitError(resultText(result) || 'workflow.submit was refused')
        else {
          setSubmitError(null)
          setSubmitted(true)
        }
      } catch (error: unknown) {
        setSubmitError(failureText(error))
      } finally {
        setSending(false)
      }
    },
    [bridge, scene],
  )

  // Headless: submit the refiner's cuts as they came, at once. A claim-once latch —
  // `ontoolinput` can be re-delivered (a reconnect, a retry) and must never submit twice.
  const autoSubmitted = useRef(false)
  useEffect(() => {
    if (!headless || autoSubmitted.current) return
    autoSubmitted.current = true
    // The refiner may have cut the whole scene. Interactively that just disables **Done**
    // and waits for a person; an unattended run has nobody to wait for and must not hang,
    // so it keeps the scene whole instead (`submit([])` ⇒ `cuts: []`,
    // `keep: [{0, end - start}]`) — an empty `keep` is what `video/slice` would refuse.
    // An island has no `ctx` to annotate the run with, so the frame's console is the only
    // channel it has to say why the machine's answer was overruled.
    const wholeSceneCut = keepForClip(input.cuts, scene).length === 0
    if (wholeSceneCut) {
      console.warn(
        'cut-editor: the refiner cut the whole scene — keeping all of it so the headless run can finish',
      )
    }
    void submit(wholeSceneCut ? [] : input.cuts)
  }, [headless, input.cuts, scene, submit])

  return (
    <div className="min-h-screen bg-surface font-sans text-ink">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b rule px-5 py-3">
        <h1 className="text-[15px] font-semibold text-ink">{scene.title || 'Trim to the screen'}</h1>
        <span className="font-mono text-[11px] text-ink-mute">
          {formatClock(scene.start)}–{formatClock(scene.end)}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {submitted && (
            <span data-testid="island-submitted" className="text-[12px] text-voice-ink">
              Sent to the run.
            </span>
          )}
          <button
            type="button"
            data-testid="island-done"
            className="pill-cta"
            disabled={sending || nothingKept}
            onClick={() => void submit(cuts)}
          >
            {sending ? 'Sending…' : 'Done'}
          </button>
        </div>
      </header>

      {signError && (
        <p
          data-testid="island-sign-error"
          className="border-b rule bg-surface-dim px-5 py-2 text-[12px] text-ink-mute"
        >
          Couldn’t load this scene’s media — {signError}
        </p>
      )}
      {nothingKept && (
        <p
          data-testid="island-nothing-kept"
          className="border-b rule bg-surface-dim px-5 py-2 text-[12px] text-ink"
        >
          Everything in this scene is cut — keep at least one span.
        </p>
      )}
      {submitError && (
        <p
          data-testid="island-submit-error"
          className="border-b rule bg-surface-dim px-5 py-2 text-[12px] text-ink"
        >
          Couldn’t send the trim — {submitError}
        </p>
      )}

      {clipUrl && (
        <video
          ref={videoRef}
          data-testid="island-clip"
          src={clipUrl}
          controls
          playsInline
          preload="metadata"
          className="max-h-[45vh] w-full bg-ink"
        />
      )}

      <CutEditor
        words={words}
        cuts={cuts}
        onEditCut={onEditCut}
        frames={frames}
        duration={scene.end}
        windowStart={scene.start}
        windowEnd={scene.end}
        originalAudioUrl={wavUrl}
        video={video}
      />
    </div>
  )
}
