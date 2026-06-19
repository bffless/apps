import { useEffect, useRef, useState, type DragEvent } from 'react'
import { skipToken } from '@reduxjs/toolkit/query'
import type { VideoSource } from '../../store/studioSlice'
import { PER_VIDEO_STAGES, type StageId } from '../../lib/pipeline'
import { sourceFileError } from '../../lib/upload'
import { useSignDownloadQuery } from '../../store/studioApi'
import { PreviewPlayer } from './PreviewPlayer'
import { AudioArtifact } from './AudioArtifact'
import { TranscriptText } from './TranscriptText'

type Props = {
  sources: VideoSource[]
  /** Transient in-memory Files keyed by source id (the page's upload map). Lets a
   *  source be previewed from its local file BEFORE it's uploaded; absent after a
   *  reload (the row then falls back to the signed bucket URL). */
  files?: Map<string, File>
  busyId: string | null
  onReorder: (from: number, to: number) => void
  onRemove: (id: string) => void
  onProcess: (id: string) => void
  onProcessAll: () => void
  /** Append more source videos to the queue (same validated File[] as import). */
  onAdd: (files: File[]) => void
  /** Resolve a diarization label to a display name for the transcript preview —
   *  the person's name once mapped, else the raw label. Omitted = raw label. */
  resolveSpeakerName?: (sourceId: string, label: string) => string
  /** Project-level: run speaker diarization during transcription (story 10e). */
  diarize?: boolean
  onDiarizeChange?: (v: boolean) => void
}

const STAGE_LABELS: Record<StageId, string> = {
  upload: 'Upload',
  extract: 'Audio',
  transcribe: 'Transcribe',
  thumbnails: 'Thumbnails',
  director: 'Director',
  clone: 'Clone',
}

type RowProps = {
  source: VideoSource
  /** This source's local File, if still in memory (pre-upload / same session). */
  file?: File
  index: number
  busy: boolean
  isThisOne: boolean
  isDragTarget: boolean
  onDragStart: (e: React.DragEvent<HTMLLIElement>) => void
  onDragOver: (e: React.DragEvent<HTMLLIElement>) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent<HTMLLIElement>) => void
  onDragEnd: () => void
  onRemove: (id: string) => void
  onProcess: (id: string) => void
  resolveSpeakerName?: (sourceId: string, label: string) => string
}

function SourceRow({
  source,
  file,
  index,
  busy,
  isThisOne,
  isDragTarget,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onRemove,
  onProcess,
  resolveSpeakerName,
}: RowProps) {
  const [expanded, setExpanded] = useState(false)
  const previewRef = useRef<HTMLVideoElement>(null)

  // Preview the local file directly (pre-upload "is this the right clip?"), no
  // upload or signing needed. The object URL is minted in the toggle handler (not an
  // effect) on first preview, so React 18 StrictMode's dev mount→unmount→remount
  // cycle can't revoke a URL the <video> still points at (that left the preview blank
  // in dev). Revoked on unmount / when replaced.
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  useEffect(() => {
    return () => {
      if (localUrl) URL.revokeObjectURL(localUrl)
    }
  }, [localUrl])

  function togglePreview() {
    if (file && !localUrl) setLocalUrl(URL.createObjectURL(file))
    setExpanded((v) => !v)
  }

  // Only sign the bucket object when there's no local file to play (e.g. after a
  // reload). Hook must be called unconditionally; conditionally skip via skipToken.
  const { data: signed } = useSignDownloadQuery(
    expanded && !localUrl && source.sourceUrl ? source.sourceUrl : skipToken,
  )

  // Local file wins (instant); else the signed bucket URL once it resolves.
  const previewSrc = localUrl ?? signed?.url ?? null
  // Offer the preview as soon as a File exists (or once the clip's been uploaded).
  const canExpand = !!file || !!source.sourceUrl

  return (
    <li
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={[
        'flex items-start gap-4 border-b bg-paper px-5 py-4 last:border-b-0 transition-colors',
        'rule',
        isDragTarget ? 'bg-terracotta/5 border-l-2 border-l-terracotta' : 'border-l-2 border-l-transparent',
      ].join(' ')}
    >
      {/* Drag handle */}
      <span
        className="mt-0.5 flex-shrink-0 cursor-grab select-none text-ink-faint"
        aria-hidden="true"
      >
        &#9776;
      </span>

      {/* Main content */}
      <div className="min-w-0 flex-1">
        {/* Filename + order */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-ink-faint">{index + 1}</span>
          <span
            data-testid="source-name"
            className="font-serif text-[17px] leading-tight text-ink truncate"
          >
            {source.fileName}
          </span>
        </div>

        {/* Per-stage status strip */}
        <div className="mt-2 flex items-center gap-4">
          {PER_VIDEO_STAGES.map((stageId) => {
            const status = source.stageProgress[stageId]?.status ?? 'pending'
            return (
              <StageIndicator
                key={stageId}
                label={STAGE_LABELS[stageId]}
                status={status}
              />
            )
          })}
        </div>

        {/* Action buttons */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="pill-cta"
            disabled={busy}
            onClick={() => onProcess(source.id)}
            aria-label={`Process this video: ${source.fileName}`}
          >
            {isThisOne ? (
              <span className="flex items-center gap-2">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-paper border-t-transparent" />
                Processing&hellip;
              </span>
            ) : (
              'Process this video'
            )}
          </button>
          <button
            type="button"
            className="pill-ghost"
            onClick={() => onRemove(source.id)}
            aria-label={`Remove ${source.fileName}`}
          >
            Remove
          </button>
          {canExpand && (
            <button
              type="button"
              className="pill-ghost"
              aria-expanded={expanded}
              onClick={togglePreview}
            >
              {expanded ? 'Hide preview' : 'Show preview'}
            </button>
          )}
        </div>

        {/* Expanded per-source detail: preview player + waveform + transcript */}
        {expanded && (
          <div className="mt-4 border rule bg-paper-deep/30 p-4 flex flex-col gap-4">
            {previewSrc ? (
              <PreviewPlayer
                src={previewSrc}
                videoRef={previewRef}
                cuts={[]}
                onLoaded={() => {}}
              />
            ) : (
              <span className="font-mono text-[12px] text-ink-faint">Loading preview&hellip;</span>
            )}
            {source.audioUrl && (
              <AudioArtifact peaks={source.audioPeaks} audioUrl={source.audioUrl} />
            )}
            {source.words.length > 0 && (
              <TranscriptText
                words={source.words}
                speakerName={
                  resolveSpeakerName ? (label) => resolveSpeakerName(source.id, label) : undefined
                }
              />
            )}
          </div>
        )}
      </div>
    </li>
  )
}

export function SourceQueue({ sources, files, busyId, onReorder, onRemove, onProcess, onProcessAll, onAdd, resolveSpeakerName, diarize = false, onDiarizeChange }: Props) {
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  // Validate dropped/picked files the same way MediaImport does, then append the
  // ones that pass. Surfaced inline below the queue.
  const [addError, setAddError] = useState<string | null>(null)
  const [addDragging, setAddDragging] = useState(false)
  const addInputRef = useRef<HTMLInputElement>(null)

  const busy = busyId !== null

  function acceptAdd(list: FileList | null | undefined) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    const errors: string[] = []
    const ok: File[] = []
    for (const f of files) {
      const err = sourceFileError(f)
      if (err) errors.push(`${f.name}: ${err}`)
      else ok.push(f)
    }
    setAddError(errors.length ? errors.join(' · ') : null)
    if (ok.length) onAdd(ok)
  }

  function onAddDrop(e: DragEvent) {
    e.preventDefault()
    setAddDragging(false)
    acceptAdd(e.dataTransfer.files)
  }

  return (
    <div>
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="meta-label">Source videos &middot; {sources.length} clip{sources.length !== 1 ? 's' : ''}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="pill-ghost"
            disabled={busy}
            onClick={() => addInputRef.current?.click()}
          >
            + Add videos
          </button>
          <button
            type="button"
            className="pill-cta"
            disabled={busy || sources.length === 0}
            onClick={onProcessAll}
          >
            Process all
          </button>
        </div>
        <input
          ref={addInputRef}
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            acceptAdd(e.target.files)
            e.target.value = '' // let re-picking the same file fire change again
          }}
        />
      </div>

      {/* Project-level diarization toggle (story 10e). Off = single-narrator fast
          path; on = detect speakers (slower, runs as an async job). Locked while
          a clip is processing so the choice can't change mid-run. */}
      <label className="mb-3 flex items-start gap-2 border rule bg-paper px-4 py-3 text-[13px] text-ink-soft">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={diarize}
          disabled={busy}
          onChange={(e) => onDiarizeChange?.(e.target.checked)}
        />
        <span>
          <span className="font-medium text-ink">Detect speakers automatically</span> — tag who&rsquo;s
          talking in each clip (diarization) so every person&rsquo;s lines get their own voice in Build
          without you sorting them out. Slower. Leave it off for a single narrator — or if you&rsquo;d
          rather just declare a few voices in the voice step and pick them per scene yourself.
        </span>
      </label>

      {/* Queue list */}
      <ol className="overflow-hidden border rule">
        {sources.map((source, index) => {
          const isThisOne = busyId === source.id
          const isDragTarget = dragOverIndex === index

          return (
            <SourceRow
              key={source.id}
              source={source}
              file={files?.get(source.id)}
              index={index}
              busy={busy}
              isThisOne={isThisOne}
              isDragTarget={isDragTarget}
              resolveSpeakerName={resolveSpeakerName}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(index))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDragOverIndex(index)
              }}
              onDragLeave={() => {
                setDragOverIndex(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                const from = parseInt(e.dataTransfer.getData('text/plain'), 10)
                setDragOverIndex(null)
                if (!isNaN(from) && from !== index) {
                  onReorder(from, index)
                }
              }}
              onDragEnd={() => {
                setDragOverIndex(null)
              }}
              onRemove={onRemove}
              onProcess={onProcess}
            />
          )
        })}
      </ol>

      {/* Drop more clips onto the queue (or use the header button). Separate from
          the per-row reorder DnD — this reads dropped files, not a row index. */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setAddDragging(true)
        }}
        onDragLeave={() => setAddDragging(false)}
        onDrop={onAddDrop}
        onClick={() => addInputRef.current?.click()}
        className={[
          'mt-3 cursor-pointer border border-dashed px-5 py-4 text-center font-mono text-[12px] uppercase tracking-wider transition-colors',
          addDragging ? 'border-terracotta bg-terracotta/5 text-terracotta' : 'rule text-ink-faint',
        ].join(' ')}
      >
        {sources.length === 0 ? 'Drop clips here or click to add' : 'Drop more clips here, or click to add'}
      </div>

      {addError && <p className="mt-2 text-[13px] text-terracotta-ink">{addError}</p>}
    </div>
  )
}

type IndicatorProps = {
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
}

function StageIndicator({ label, status }: IndicatorProps) {
  const dot = (() => {
    if (status === 'done')
      return <span className="flex h-2.5 w-2.5 flex-shrink-0 items-center justify-center rounded-full bg-terracotta text-[8px] font-bold text-paper">&#10003;</span>
    if (status === 'error')
      return <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-terracotta-ink" />
    if (status === 'active')
      return <span className="h-2.5 w-2.5 flex-shrink-0 animate-ping rounded-full bg-terracotta" />
    return <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full border border-paper-line bg-paper" />
  })()

  return (
    <span className="flex items-center gap-1.5">
      {dot}
      <span
        className={[
          'font-mono text-[10px] uppercase tracking-wider',
          status === 'done'
            ? 'text-ink-mute line-through decoration-ink-faint'
            : status === 'active'
              ? 'text-terracotta'
              : status === 'error'
                ? 'text-terracotta-ink'
                : 'text-ink-faint',
        ].join(' ')}
      >
        {label}
      </span>
    </span>
  )
}
