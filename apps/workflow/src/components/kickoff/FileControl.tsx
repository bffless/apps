/**
 * The `file` field (02/06): uploads on select (prepare → PUT → register) with
 * a progress bar and inline `accept`/`maxSize` errors (Decision 8). The
 * field's value only ever becomes the returned File ref (or a `FileRef[]` for
 * `list: true`), never a raw `File`. When no `upload` is given — a caller that
 * has no scope to upload into — it renders an unsupported notice instead of a
 * picker, so a workflow with file fields still opens.
 *
 * **Why the refs are held in a ref.** A `list: true` field appends to what is
 * already there (`[...refs, ...uploaded]`), and `refs` is derived from the
 * `value` prop of the render that *started* the upload. Pick two files, then
 * pick a third before the first pair lands, and the second batch resolves
 * against the pre-upload value — silently dropping the pair that had just
 * finished. `refsRef` is the same list read at the moment the batch resolves
 * and updated as each batch emits, so appends compose instead of clobbering.
 *
 * Progress is per *batch*: each file reports its own fraction and the bar
 * shows their mean (a shared `setProgress` across `Promise.all` used to make
 * three files fight over one number), and the bar only clears once the last
 * batch in flight is done.
 *
 * An `image/*` ref (an `accept: image/*` field's upload, or a Re-run prefill)
 * shows a thumbnail beside its name (apps#437) — a person attaching a
 * reference photo should see it, not just its file name. The gate is the
 * ref's own `contentType` (what `files/register` echoed from CE), and the
 * `<img src>` only ever takes `url` through `isSameOriginUrl`, the same rule
 * a tile's preview obeys: a ref can be run-row JSON, and a cross-origin image
 * is a beacon that carries the member's session. No presigning here — unlike
 * an island's opaque-origin frame, this page is same-origin and sends the
 * cookie the serve route wants.
 */
import { useEffect, useRef, useState } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import type { FileRef } from '../../lib/runner/types'
import { isSameOriginUrl } from '../../lib/url'
import { isFileRef } from '../values/fileRef'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function humanSize(bytes: number): string {
  let n = bytes
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(1)} ${UNITS[i]}`
}

/** `accept` (02): a comma-separated list of MIME types, `type/*`, or `.ext`. */
function matchesAccept(file: File, accept: string): boolean {
  return accept
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern.startsWith('.')) return file.name.toLowerCase().endsWith(pattern.toLowerCase())
      if (pattern.endsWith('/*')) return file.type.startsWith(pattern.slice(0, -1))
      return file.type === pattern
    })
}

/** The File refs a value already holds — a list keeps them all, a single field at most one. */
function refsOf(value: unknown, list: boolean): FileRef[] {
  if (list) return Array.isArray(value) ? value.filter(isFileRef) : []
  return isFileRef(value) ? [value] : []
}

/** The same-origin url of an `image/*` ref — the only thing a thumbnail may be drawn from. */
function previewUrl(ref: FileRef): string | undefined {
  const contentType = typeof ref.contentType === 'string' ? ref.contentType : ''
  return contentType.startsWith('image/') && isSameOriginUrl(ref.url) ? ref.url : undefined
}

export function FileControl({
  def,
  value,
  onChange,
  upload,
  inputId,
  invalid,
  describedBy,
  onError,
}: {
  def: InputDef
  value: unknown
  onChange: (v: unknown) => void
  upload?: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
  inputId: string
  invalid: boolean
  describedBy: string | undefined
  onError: (message: string | undefined) => void
}) {
  const [progress, setProgress] = useState<number | null>(null)
  const list = def.list === true
  const accept = typeof def.accept === 'string' ? def.accept : undefined
  const maxSize = typeof def.maxSize === 'number' ? def.maxSize : undefined

  const refs = refsOf(value, list)

  // Mirrors the committed value for the async path above; written on every
  // commit so a value the *parent* changed (a reset, a different step) is what
  // the next batch appends to.
  const refsRef = useRef(refs)
  useEffect(() => {
    refsRef.current = refsOf(value, list)
  })

  // How many upload batches are still running: the bar belongs to all of them.
  const batchesRef = useRef(0)

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || !upload) return
    const picked = Array.from(files)

    for (const file of picked) {
      if (accept && !matchesAccept(file, accept)) {
        onError(`"${file.name}" is not a ${accept} file`)
        return
      }
      if (maxSize !== undefined && file.size > maxSize) {
        onError(`"${file.name}" is larger than ${humanSize(maxSize)}`)
        return
      }
    }

    onError(undefined)
    const fractions = picked.map(() => 0)
    batchesRef.current += 1
    setProgress(0)
    try {
      const uploaded = await Promise.all(
        picked.map((file, i) =>
          upload(file, (fraction) => {
            fractions[i] = fraction
            setProgress(fractions.reduce((sum, f) => sum + f, 0) / fractions.length)
          }),
        ),
      )
      const next = list ? [...refsRef.current, ...uploaded] : (uploaded[0] ?? null)
      // Emit *and* remember: a batch that resolves before this one's `onChange`
      // has been committed must still append to it, not to the value before it.
      refsRef.current = list ? (next as FileRef[]) : refsOf(next, false)
      onChange(next)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      batchesRef.current -= 1
      if (batchesRef.current === 0) setProgress(null)
    }
  }

  if (!upload) {
    return <p className="note">File uploads are not supported here yet.</p>
  }

  return (
    <div className="field-file">
      <input
        id={inputId}
        type="file"
        accept={accept}
        multiple={list}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(e) => {
          void handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {progress !== null && (
        <progress className="field-progress" value={progress} max={1} aria-label={`Uploading ${def.label ?? ''}`} />
      )}
      {refs.length > 0 && (
        <ul className="field-file-list">
          {refs.map((ref) => {
            const preview = previewUrl(ref)
            return (
              <li key={ref.path} className="field-file-item">
                {preview !== undefined && (
                  <img className="field-file-preview" data-testid="file-preview" src={preview} alt={ref.name} />
                )}
                <span className="field-file-name">{ref.name}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
