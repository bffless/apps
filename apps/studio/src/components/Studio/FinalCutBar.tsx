import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Scene } from '../../lib/scenes'
import { assembleFinalCutBlob } from '../../lib/export/assembleScene'
import { useSignedBytes } from './useSignedBytes'
import { useSignDownloadQuery } from '../../store/studioApi'
import { skipToken } from '@reduxjs/toolkit/query'

type Props = {
  scenes: Scene[]
  /** The saved final cut's serve path (persisted) — survives reload. */
  finalCutUrl: string | null
  /** True while the stitched final cut is uploading. */
  saving: boolean
  /** Upload the final blob → bucket; resolves to the saved serve URL. */
  onSave: (blob: Blob) => Promise<string>
}

/**
 * The **master assemble** (story 03g phase 2): stitch every scene's already-saved
 * assembled cut (`scene.assembledUrl`) into the whole video. Pure stream-copy
 * concat (`buildConcatCommand` → `concat`) — no re-encode, near-instant, and almost
 * no memory, so it never approaches the OOM the old whole-film pass hit. Enabled
 * only once every scene has been assembled & saved.
 */
export function FinalCutBar({ scenes, finalCutUrl, saving, onSave }: Props) {
  // Serve-path-aware fetch: each assembled scene is tens of MB — sign them to
  // the bucket instead of streaming every one through the BFFless backend.
  const fetchBytes = useSignedBytes()
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState('')
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

  // Scenes in order; we need every one assembled to stitch the whole thing.
  const assembled = useMemo(() => scenes.filter((s) => s.assembledUrl), [scenes])
  const allAssembled = scenes.length > 0 && assembled.length === scenes.length
  const pending = scenes.filter((s) => !s.assembledUrl)

  const savedCurrent = !!resultBlob && savedBlob === resultBlob
  // Playback of the SAVED final cut signs the serve path to a direct bucket
  // URL (the whole video — the biggest MP4 we serve — must never stream
  // through file_serve). The download link keeps the serve path: `download`
  // is ignored on cross-origin URLs, so signing it would cost the filename.
  const { data: signedFinal } = useSignDownloadQuery(finalCutUrl ?? skipToken)
  const playbackSrc = resultUrl ?? (finalCutUrl ? (signedFinal?.url ?? null) : null)
  const downloadHref = resultUrl ?? finalCutUrl

  const run = useCallback(async () => {
    if (running || !allAssembled) return
    setRunning(true)
    setError(null)
    setSaveError(null)
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl)
      setResultUrl(null)
    }
    setResultBlob(null)
    try {
      const blob = await assembleFinalCutBlob({ scenes, fetchBytes, onStage: setStage })
      setResultBlob(blob)
      setResultUrl(URL.createObjectURL(blob))
      setStage(`Done · ${(blob.size / 1_048_576).toFixed(1)} MB · save it to keep it`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage('')
    } finally {
      setRunning(false)
    }
  }, [running, allAssembled, scenes, resultUrl, fetchBytes])

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
      <p className="meta-label">Export · stitch the final cut</p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
        Once every scene is assembled & saved, stitch them into the whole video. This
        is a fast join of the scenes you’ve already rendered — no re-encoding — then
        <span className="text-ink"> save</span> it or download a copy.
      </p>

      <p className="mt-3 text-[12.5px]">
        {allAssembled ? (
          <span className="text-ink">
            ✓ All {scenes.length} scenes assembled — ready to stitch.
          </span>
        ) : (
          <span className="text-ink-soft">
            {assembled.length}/{scenes.length} scenes assembled — assemble{' '}
            {pending.length === 1 ? 'the last one' : `${pending.length} more`} (per tab) first.
          </span>
        )}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={resultBlob ? 'pill-ghost' : 'pill-cta'}
          disabled={running || saving || !allAssembled}
          onClick={run}
        >
          {running ? 'Stitching…' : resultBlob || finalCutUrl ? 'Re-stitch final cut' : 'Stitch final cut'}
        </button>

        {resultBlob && !running && !savedCurrent && (
          <button type="button" className="pill-cta" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save to my library'}
          </button>
        )}
        {savedCurrent && <span className="text-[12.5px] text-ink-soft">✓ Saved</span>}

        {downloadHref && !running && (
          <a className="pill-ghost" href={downloadHref} download="studio-final-cut.mp4">
            Download MP4
          </a>
        )}
      </div>

      {finalCutUrl && !resultBlob && !running && (
        <p className="mt-3 text-[12.5px] text-ink-soft">
          Showing your saved final cut. Re-assemble any scene and re-stitch to update it.
        </p>
      )}

      {(running || stage) && !error && stage && (
        <p className="mt-3 text-[12.5px] text-ink-soft">{stage}</p>
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
