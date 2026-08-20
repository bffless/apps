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
 */
import { isSafeUrl } from '../../lib/url'
import type { FileRef } from '../../lib/runner/types'

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

/** 02: the Download action is always `url + (?|&) + download=1`. */
function downloadHref(url: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'download=1'
}

function Player({ contentType, url, name }: { contentType?: string; url: string; name: string }) {
  if (!contentType) return null
  if (contentType.startsWith('video/')) return <video controls src={url} />
  if (contentType.startsWith('audio/')) return <audio controls src={url} />
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
