/**
 * The `file` type's default viewer (02): a player chosen by `contentType`
 * prefix, with name/size/contentType/Download always shown regardless of
 * whether a player could be rendered.
 *
 * `url` arrives from a run row's JSON, which any authenticated member can
 * write. Two different gates apply, because the Download link and the player
 * are two different sinks: the Download `<a href>` goes through `isSafeUrl`,
 * the same allow-list a markdown link href uses (`lib/url`), so any http(s)
 * ref — cross-origin included — still gets a Download action (02: "always a
 * Download action"). The player (`<video>`/`<audio>`/`<img>`/`<object data>`)
 * is a stricter sink: it goes through `isSameOriginUrl`, because a
 * cross-origin `src` would leak the member's session cookie to a third party
 * the same way an untrusted fetch would. A url that fails `isSafeUrl` is
 * shown as text instead of a Download link: the card still reports what it
 * saw, it just refuses to be the thing that navigates or fetches it. A url
 * that passes `isSafeUrl` but fails `isSameOriginUrl` still gets its Download
 * link, just no player.
 *
 * A `video`/`audio` player is the shared `MediaPreview` (apps#451): controls,
 * `preload="metadata"`, and the duration it reports joins the meta row beside
 * name and size — a step's Input pane shows the same playable, scrubbable
 * card the kickoff form did for the recording just uploaded. It also
 * registers its element with `MediaSeekContext` (Task 15) so a `transcript`
 * renderer's segment click can seek it — a `ref` callback rather than a
 * `useEffect`, so the element is registered the instant it mounts and
 * unregistered the instant it's removed, with no one-tick gap either way.
 * `useMediaSeek()` is safe with no provider in the tree (a no-op `register`),
 * so every `FileCard` outside a transcript's scope — an Input tab, a bare
 * `ValueView` in a test — is unaffected.
 */
import { useCallback, useRef, useState } from 'react'
import { downloadHref, isSafeUrl, isSameOriginUrl } from '../../lib/url'
import type { FileRef } from '../../lib/runner/types'
import { formatDuration, mediaKind } from './media'
import { MediaPreview } from './MediaPreview'
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

function Player({
  contentType,
  url,
  name,
  onDuration,
}: {
  contentType?: string
  url: string
  name: string
  onDuration: (seconds: number) => void
}) {
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
  const kind = mediaKind(contentType)
  if (kind) return <MediaPreview kind={kind} src={url} name={name} onDuration={onDuration} mediaRef={mediaRef} />
  if (contentType.startsWith('image/')) return <img src={url} alt={name} />
  if (contentType === 'application/pdf') return <object type={contentType} data={url} />
  return null
}

export function FileCard({ refValue }: { refValue: FileRef }) {
  const { name, contentType, size, url } = refValue
  const safe = typeof url === 'string' && isSafeUrl(url)
  const sameOrigin = typeof url === 'string' && isSameOriginUrl(url)
  const [duration, setDuration] = useState<number | undefined>(undefined)
  const durationLabel = formatDuration(duration)
  return (
    <div className="file-card">
      {sameOrigin && <Player contentType={contentType} url={url} name={name} onDuration={setDuration} />}
      <div className="file-card-meta">
        <span className="file-card-name">{name}</span>
        <span className="file-card-type">{contentType || 'unknown type'}</span>
        {typeof size === 'number' && size > 0 && <span className="file-card-size">{humanSize(size)}</span>}
        {durationLabel !== undefined && (
          <span className="file-card-duration" data-testid="file-duration">
            {durationLabel}
          </span>
        )}
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
