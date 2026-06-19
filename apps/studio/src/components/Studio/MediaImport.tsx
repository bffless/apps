import { useRef, useState, type DragEvent } from 'react'
import { sourceFileError } from '../../lib/upload'

type Props = {
  onSelect: (files: File[]) => void
}

/**
 * Phase 0–1 entry point: import-only. Drag one or more screen recordings in or
 * pick them. (A built-in recorder is a later phase.) We hand the raw File[]
 * up; the page owns the object URL lifecycle.
 */
export function MediaImport({ onSelect }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function accept(list: FileList | null | undefined) {
    const files = Array.from(list ?? [])
    if (files.length === 0) return
    const errors: string[] = []
    const ok: File[] = []
    for (const f of files) {
      const err = sourceFileError(f)
      if (err) errors.push(`${f.name}: ${err}`)
      else ok.push(f)
    }
    setError(errors.length ? errors.join(' · ') : null)
    if (ok.length) onSelect(ok)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    accept(e.dataTransfer.files)
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={[
        'corner-marks flex flex-col items-center justify-center gap-4 border border-dashed px-8 py-20 text-center transition-colors',
        dragging ? 'border-terracotta bg-terracotta/5' : 'rule bg-paper-deep/30',
      ].join(' ')}
    >
      <p className="meta-label">Import footage</p>
      <h3 className="max-w-md font-serif text-[24px] leading-tight text-ink">
        Drop your clips to auto-shorten
      </h3>
      <p className="max-w-sm text-[14.5px] leading-relaxed text-ink-soft">
        Add one or more long recordings. The browser reads them locally to extract audio
        and frames, then the pipeline does the rest. MP4, WebM, or MOV all work.
      </p>
      <button type="button" className="pill-cta mt-1" onClick={() => inputRef.current?.click()}>
        Choose files
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={(e) => accept(e.target.files)}
      />
      {error && <p className="text-[13px] text-terracotta-ink">{error}</p>}
    </div>
  )
}
