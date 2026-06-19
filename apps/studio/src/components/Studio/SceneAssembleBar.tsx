import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Scene } from '../../lib/scenes'
import { effectiveCuts, effectiveSegments, overlaps } from '../../lib/refiner'
import { planScene } from '../../lib/export/assemble'
import { assembleSceneBlob } from '../../lib/export/assembleScene'
import { useSignedBytes } from './useSignedBytes'
import { useSignDownloadQuery } from '../../store/studioApi'
import { skipToken } from '@reduxjs/toolkit/query'

type Props = {
  /** The scene whose tab is selected — this bar assembles ONLY this scene. */
  scene: Scene
  /** True while this scene's assembled cut is uploading. */
  saving: boolean
  /** Upload the assembled scene blob → bucket; resolves to its serve URL. */
  onSave: (blob: Blob) => Promise<string>
  /** Open the scene preview dialog (owned by the page — shared with the sticky tabs). */
  onPreview: () => void
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * Assemble **one scene** (story 03g phase 2) — the producer works tab by tab:
 * assemble the selected scene off its own cut clip (`scene.clipUrl`), preview it,
 * save it (`scene.assembledUrl`), then move to the next tab. Because the source is
 * the short per-scene clip — not the whole film — only that clip is ever in wasm
 * memory, which is what keeps the render from OOMing.
 *
 * The plan is the pure `planScene` walk (cuts dropped / narration over kept video /
 * dead space silent), rebased to the clip's local time. The final whole-video cut
 * is a separate, cheap concat of every scene's saved `assembledUrl` (see FinalCutBar).
 *
 * Mounted with `key={scene.id}` so switching tabs resets this transient state.
 */
export function SceneAssembleBar({ scene, saving, onSave, onPreview }: Props) {
  // Serve-path-aware fetch: swaps `/api/uploads/...` for direct bucket URLs so
  // the big clip download doesn't crawl through (or OOM) the BFFless backend.
  const fetchBytes = useSignedBytes()
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [savedBlob, setSavedBlob] = useState<Blob | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const resultRef = useRef<string | null>(null)
  useEffect(() => {
    resultRef.current = resultUrl
    return () => {
      if (resultRef.current) URL.revokeObjectURL(resultRef.current)
    }
  }, [resultUrl])

  // This scene's effective narration segments + cuts, rebased to the clip's local
  // timeline (the clip starts at scene.start, so the plan walks [0, end-start]).
  const segments = useMemo(() => effectiveSegments(scene), [scene])
  const plan = useMemo(
    () => planScene({ segments, cuts: effectiveCuts(scene), start: scene.start, end: scene.end }),
    [segments, scene],
  )

  const sceneLen = Math.max(0, scene.end - scene.start)
  const droppedSeconds = Math.max(0, sceneLen - plan.duration)
  const unvoiced = segments.filter((s) => !s.audioUrl).length
  const hasClip = !!scene.clipUrl
  // Overlapping runs block assemble (story 03h): the assembler doesn't mix audio
  // (no `amix`), so the producer resolves overlaps by moving/deleting a run
  // first. Belt-and-braces — the planner's first-run-wins walk stays as the
  // deterministic fallback, so a stray overlap can never crash a render.
  const overlapCount = useMemo(() => overlaps(segments).length, [segments])
  const canAssemble = hasClip && plan.video.length > 0 && overlapCount === 0

  const savedCurrent = !!resultBlob && savedBlob === resultBlob
  // Playback of the SAVED cut signs the serve path to a direct bucket URL (a
  // big MP4 must never stream through file_serve — it buffers/OOMs the
  // backend). The download link keeps the serve path: `download` is ignored on
  // cross-origin URLs, so signing it would cost the filename.
  const { data: signedAssembled } = useSignDownloadQuery(scene.assembledUrl ?? skipToken)
  const playbackSrc = resultUrl ?? (scene.assembledUrl ? (signedAssembled?.url ?? null) : null)
  const downloadHref = resultUrl ?? scene.assembledUrl ?? null

  const run = useCallback(async () => {
    if (running || !canAssemble || !scene.clipUrl) return
    setRunning(true)
    setError(null)
    setSaveError(null)
    setProgress(0)
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl)
      setResultUrl(null)
    }
    setResultBlob(null)
    try {
      const blob = await assembleSceneBlob({
        scene,
        fetchBytes,
        onStage: setStage,
        onProgress: setProgress,
      })
      setResultBlob(blob)
      setResultUrl(URL.createObjectURL(blob))
      setStage(`Done · ${(blob.size / 1_048_576).toFixed(1)} MB · save it to keep it`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage('')
    } finally {
      setRunning(false)
    }
  }, [running, canAssemble, scene, resultUrl, fetchBytes])

  const save = useCallback(async () => {
    if (!resultBlob || saving) return
    setSaveError(null)
    try {
      await onSave(resultBlob)
      setSavedBlob(resultBlob)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    }
  }, [resultBlob, saving, onSave])

  return (
    <div className="border rule bg-paper p-5">
      <p className="meta-label">Assemble this scene</p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
        Render <span className="text-ink">just this scene</span> from its cut clip —
        cut footage dropped, your re-voiced narration over the kept video, dead space
        silent — then save it. Do each scene tab by tab; the final cut is stitched
        from the scenes you’ve assembled.
      </p>

      {!hasClip ? (
        <p className="mt-3 text-[12.5px] text-terracotta-ink">
          Cut this scene first (step 0 above) — the assemble works on the scene’s own clip.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-ink-mute">
          <span>
            {fmtTime(sceneLen)} → {fmtTime(plan.duration)} ({fmtTime(droppedSeconds)} cut)
          </span>
          <span>{plan.audio.filter((a) => a.kind === 'clip').length} narration clips</span>
          {unvoiced > 0 && (
            <span className="text-terracotta-ink">
              {unvoiced} run{unvoiced === 1 ? '' : 's'} unvoiced → silent
            </span>
          )}
          {overlapCount > 0 && (
            <span className="text-amber-700">
              Resolve {overlapCount} overlapping run{overlapCount === 1 ? '' : 's'} first
            </span>
          )}
          {scene.assembledUrl && !resultBlob && <span className="text-ink">✓ assembled</span>}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="pill-ghost"
          disabled={plan.video.length === 0}
          onClick={onPreview}
        >
          Preview
        </button>

        <button
          type="button"
          className={resultBlob ? 'pill-ghost' : 'pill-cta'}
          disabled={running || saving || !canAssemble}
          onClick={run}
        >
          {running
            ? 'Assembling…'
            : resultBlob || scene.assembledUrl
              ? 'Re-assemble scene'
              : 'Assemble scene'}
        </button>

        {resultBlob && !running && !savedCurrent && (
          <button type="button" className="pill-cta" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save this scene'}
          </button>
        )}
        {savedCurrent && <span className="text-[12.5px] text-ink-soft">✓ Saved</span>}

        {downloadHref && !running && (
          <a className="pill-ghost" href={downloadHref} download={`scene-${scene.index + 1}.mp4`}>
            Download
          </a>
        )}
      </div>

      {scene.assembledUrl && !resultBlob && !running && (
        <p className="mt-3 text-[12.5px] text-ink-soft">
          Showing this scene’s saved cut. Re-assemble to update it, then save again.
        </p>
      )}

      {(running || stage) && !error && (
        <div className="mt-4">
          {running && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-deep">
              <div
                className="h-full bg-terracotta transition-[width] duration-200"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}
          {stage && <p className="mt-2 text-[12.5px] text-ink-soft">{stage}</p>}
        </div>
      )}

      {error && <p className="mt-3 whitespace-pre-wrap text-[13px] text-terracotta-ink">{error}</p>}
      {saveError && <p className="mt-3 text-[13px] text-terracotta-ink">Couldn’t save: {saveError}</p>}

      {playbackSrc && !running && (
        <div className="mt-4">
          <video
            src={playbackSrc}
            controls
            crossOrigin="anonymous"
            className="w-full rounded-md border border-paper-line"
          />
        </div>
      )}

    </div>
  )
}
