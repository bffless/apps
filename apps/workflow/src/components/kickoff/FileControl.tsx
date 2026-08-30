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
 * **Previews.** A person attaching a file should see it, not just its name
 * (apps#437, apps#451): an `image/*` file shows a thumbnail beside its name,
 * a `video/*` or `audio/*` file an inline player (`values/MediaPreview` —
 * controls, `preload="metadata"`, never autoplaying) with its duration beside
 * the name and size, so a ten-minute run is not started on the wrong
 * recording. Two sources, in turn:
 *
 * - **While uploading**, a video/audio file is played from the chosen `File`
 *   itself, through an object URL — the bytes are already on this machine, so
 *   the player is ready before the upload is (an image waits for its
 *   registered url, as before). These are the `pending` rows, listed after
 *   the refs the field already holds (a single field shows the pending file
 *   *instead* of the ref it is about to replace), and a row keeps its key
 *   when its ref lands, so the row — and the name the person is reading —
 *   stays put rather than being torn down and redrawn. Each object URL is
 *   revoked the moment its batch settles, and any still alive on unmount are
 *   revoked then.
 * - **Once registered**, the ref's own same-origin `url` — the serve route
 *   honours `Range`, so `preload="metadata"` reads only the header — which is
 *   also what a Re-run prefill or a Resume has, so the preview survives a
 *   reload. The gate is the ref's `contentType` (what `files/register` echoed
 *   from CE), and the `src` only ever takes `url` through `isSameOriginUrl`,
 *   the same rule a tile's preview obeys: a ref can be run-row JSON, and a
 *   cross-origin `src` is a beacon that carries the member's session. No
 *   presigning here — unlike an island's opaque-origin frame, this page is
 *   same-origin and sends the cookie the serve route wants.
 *
 * A `list: true` field collapses each player behind a Play button
 * (`MediaPreview`'s `collapsed`), so ten recordings are ten small tiles, not
 * ten full-width players; a single field's player is open from the start.
 */
import { useEffect, useRef, useState } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import type { FileRef } from '../../lib/runner/types'
import { isSameOriginUrl } from '../../lib/url'
import { isFileRef } from '../values/fileRef'
import { formatDuration, mediaKind } from '../values/media'
import { MediaPreview } from '../values/MediaPreview'

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

/** What one row of the list draws: a ref the field holds, or a file still on its way up. */
interface FileItem {
  key: string
  name: string
  size: number | undefined
  contentType: string
  /** The url a preview may be drawn from — absent when there is nothing safe to draw. */
  src: string | undefined
}

function itemOfRef(ref: FileRef, key: string): FileItem {
  const contentType = typeof ref.contentType === 'string' ? ref.contentType : ''
  const previewable = contentType.startsWith('image/') || mediaKind(contentType) !== undefined
  return {
    key,
    name: ref.name,
    size: typeof ref.size === 'number' ? ref.size : undefined,
    contentType,
    src: previewable && isSameOriginUrl(ref.url) ? ref.url : undefined,
  }
}

/**
 * An object URL for a video/audio file, or `undefined` — a document or an
 * image gets no local preview, so it gets no URL to revoke either. Guarded on
 * the API itself: a render with no `URL.createObjectURL` just shows the name,
 * exactly as a non-previewable file does.
 */
function objectUrlFor(file: File): string | undefined {
  if (mediaKind(file.type) === undefined || typeof URL.createObjectURL !== 'function') return undefined
  return URL.createObjectURL(file)
}

function FileRow({ item, collapsed }: { item: FileItem; collapsed: boolean }) {
  const [duration, setDuration] = useState<number | undefined>(undefined)
  const kind = mediaKind(item.contentType)
  const durationLabel = formatDuration(duration)
  return (
    <li className={`field-file-item${kind && item.src ? ' field-file-item-media' : ''}`}>
      {item.src !== undefined && kind !== undefined && (
        <MediaPreview kind={kind} src={item.src} name={item.name} collapsed={collapsed} onDuration={setDuration} />
      )}
      {item.src !== undefined && kind === undefined && (
        <img className="field-file-preview" data-testid="file-preview" src={item.src} alt={item.name} />
      )}
      <span className="field-file-meta">
        <span className="field-file-name">{item.name}</span>
        {item.size !== undefined && <span className="field-file-size">{humanSize(item.size)}</span>}
        {durationLabel !== undefined && (
          <span className="field-file-duration" data-testid="file-duration">
            {durationLabel}
          </span>
        )}
      </span>
    </li>
  )
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
  // The files still uploading, each with the object URL its preview draws from.
  const [pending, setPending] = useState<FileItem[]>([])
  // The pending row's key, by the path its ref landed under: the ref row
  // takes it over, so React keeps the row rather than replacing it.
  const [keyByPath, setKeyByPath] = useState<Record<string, string>>({})
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
  // Every object URL minted and not yet revoked — a batch revokes its own as
  // it settles; unmount revokes whatever a still-running batch left.
  const objectUrlsRef = useRef(new Set<string>())
  const batchSeq = useRef(0)

  useEffect(() => {
    const urls = objectUrlsRef.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  function releaseBatch(items: FileItem[]) {
    for (const item of items) {
      if (item.src !== undefined && objectUrlsRef.current.delete(item.src)) URL.revokeObjectURL(item.src)
    }
    setPending((rows) => rows.filter((row) => !items.includes(row)))
  }

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
    const batch = ++batchSeq.current
    const items: FileItem[] = picked.map((file, i) => {
      const src = objectUrlFor(file)
      if (src !== undefined) objectUrlsRef.current.add(src)
      return { key: `pending-${batch}-${i}`, name: file.name, size: file.size, contentType: file.type, src }
    })
    setPending((rows) => (list ? [...rows, ...items] : items))

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
      setKeyByPath((keys) => ({ ...keys, ...Object.fromEntries(uploaded.map((ref, i) => [ref.path, items[i]!.key])) }))
      const next = list ? [...refsRef.current, ...uploaded] : (uploaded[0] ?? null)
      // Emit *and* remember: a batch that resolves before this one's `onChange`
      // has been committed must still append to it, not to the value before it.
      refsRef.current = list ? (next as FileRef[]) : refsOf(next, false)
      onChange(next)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      releaseBatch(items)
      batchesRef.current -= 1
      if (batchesRef.current === 0) setProgress(null)
    }
  }

  if (!upload) {
    return <p className="note">File uploads are not supported here yet.</p>
  }

  const held = refs.map((ref) => itemOfRef(ref, keyByPath[ref.path] ?? ref.path))
  const items = list || pending.length === 0 ? [...held, ...pending] : pending

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
      {items.length > 0 && (
        <ul className="field-file-list">
          {items.map((item) => (
            <FileRow key={item.key} item={item} collapsed={list} />
          ))}
        </ul>
      )}
    </div>
  )
}
