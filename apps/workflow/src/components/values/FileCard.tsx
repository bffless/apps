/**
 * The `file` type's default viewer (02): a player chosen by `contentType`
 * prefix, with name/size/contentType/Download always shown regardless of
 * whether a player could be rendered.
 *
 * `url` arrives from a run row's JSON, which any authenticated member can
 * write — so it goes through the same allow-list a markdown link href does
 * (`lib/url`) before it reaches an `src`/`data`/`href`. A url that fails it
 * is shown as text: the card still reports what it saw, it just refuses to
 * be the thing that navigates or fetches it.
 *
 * A `video`/`audio` player also registers its element with `MediaSeekContext`
 * (Task 15) so a `transcript` renderer's segment click can seek it — a `ref`
 * callback rather than a `useEffect`, so the element is registered the
 * instant it mounts and unregistered the instant it's removed, with no
 * one-tick gap either way. `useMediaSeek()` is safe with no provider in the
 * tree (a no-op `register`), so every `FileCard` outside a transcript's scope
 * — an Input tab, a bare `ValueView` in a test — is unaffected.
 */
import { useCallback, useRef } from 'react'
import { downloadHref, isSafeUrl } from '../../lib/url'
import type { FileRef } from '../../lib/runner/types'
import { useMediaSeek } from './MediaSeekContext'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function humanSize(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let n = bytes
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(1)} ${UNITS[i]}`
}

function Player({ contentType, url, name }: { contentType?: string; url: string; name: string }) {
  const { register } = useMediaSeek()
  const unregister = useRef<(() => void) | null>(null)
  const mediaRef = useCallback(
    (el: HTMLVideoElement | HTMLAudioElement | null) => {
      if (el) {
        unregister.current = register(el)
      } else {
        unregister.current?.()
        unregister.current = null
      }
    },
    [register],
  )

  if (!contentType) return null
  if (contentType.startsWith('video/')) return <video controls src={url} ref={mediaRef} />
  if (contentType.startsWith('audio/')) return <audio controls src={url} ref={mediaRef} />
  if (contentType.startsWith('image/')) return <img src={url} alt={name} />
  if (contentType === 'application/pdf') return <object type={contentType} data={url} />
  return null
}

export function FileCard({ refValue }: { refValue: FileRef }) {
  const { name, contentType, size, url } = refValue
  const safe = typeof url === 'string' && isSafeUrl(url)
  return (
    <div className="file-card">
      {safe && <Player contentType={contentType} url={url} name={name} />}
      <div className="file-card-meta">
        <span className="file-card-name">{name}</span>
        <span className="file-card-type">{contentType || 'unknown type'}</span>
        <span className="file-card-size">{humanSize(size)}</span>
        {safe ? (
          <a className="file-card-download" href={downloadHref(url)} download>
            Download
          </a>
        ) : (
          <span className="file-card-blocked" title="This file url is not a safe link">
            {String(url)}
          </span>
        )}
      </div>
    </div>
  )
}
