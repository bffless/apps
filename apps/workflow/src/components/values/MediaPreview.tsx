/**
 * The one inline player a `video/*` or `audio/*` file gets, wherever a file
 * is shown (02, apps#451): a file field's chosen file (kickoff form and form
 * steps, `kickoff/FileControl`) and a File ref's card (`FileCard`, the step
 * and run Input panes). Before a ten-minute run starts the person wants to
 * confirm it is the right recording — play it, scrub it, see how long it is —
 * so the element is always `controls` + `preload="metadata"`: scrubbable,
 * never autoplaying, and the browser reads only the header (the serve route
 * honours `Range`) until play is pressed.
 *
 * **Collapsed.** A `list: true` field with ten recordings must not be ten
 * full-width players. `collapsed` draws the element small and without
 * controls — a poster-sized tile showing the first frame (audio has no frame,
 * so its tile is just the button) — behind one Play button; the click opens
 * the player in place and starts it. The same element stays mounted across
 * that flip, so the metadata it already loaded (and the duration it reported)
 * carry over rather than being fetched twice.
 *
 * **Duration** is the caller's to show, beside the name and size it already
 * prints: `onDuration` fires from `loadedmetadata`, and only with a finite
 * number — a live stream, an unreadable file, or jsdom report `NaN`/`Infinity`
 * and the caller then simply shows no duration.
 *
 * `src` is the caller's problem: a file field hands over an object URL of the
 * local `File` or a ref's serve url, and `FileCard` its `isSameOriginUrl`-
 * checked ref url. Nothing here decides whether a url is safe to load.
 *
 * `mediaRef` lets `FileCard` keep registering the element with
 * `MediaSeekContext` (a transcript's segment click seeks it) exactly as it
 * did before this component existed.
 */
import { useCallback, useRef, useState } from 'react'
import type { SyntheticEvent } from 'react'
import type { MediaKind } from './media'

export function MediaPreview({
  kind,
  src,
  name,
  collapsed = false,
  onDuration,
  mediaRef,
}: {
  kind: MediaKind
  src: string
  name: string
  /** Start as a poster tile behind a Play button (a list's players); open in place on click. */
  collapsed?: boolean
  /** The media's duration in seconds, once its metadata has loaded. */
  onDuration?: (seconds: number) => void
  /** A ref callback for the element itself (FileCard's seek registration). */
  mediaRef?: (el: HTMLVideoElement | HTMLAudioElement | null) => void
}) {
  const [open, setOpen] = useState(!collapsed)
  const elRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)

  const setEl = useCallback(
    (el: HTMLVideoElement | HTMLAudioElement | null) => {
      elRef.current = el
      mediaRef?.(el)
    },
    [mediaRef],
  )

  function handleLoadedMetadata(e: SyntheticEvent<HTMLMediaElement>) {
    const { duration } = e.currentTarget
    if (Number.isFinite(duration)) onDuration?.(duration)
  }

  function play() {
    setOpen(true)
    const el = elRef.current
    if (!el) return
    // `play()` returns a promise that rejects when the browser refuses (no
    // gesture, an unplayable codec); the controls are on screen by then and
    // say so themselves, so the rejection is nothing to surface here.
    const result: unknown = el.play()
    if (result instanceof Promise) result.catch(() => {})
  }

  const shared = {
    ref: setEl,
    src,
    preload: 'metadata' as const,
    controls: open,
    'data-testid': 'file-media',
    onLoadedMetadata: handleLoadedMetadata,
  }

  return (
    <div className={`media-preview media-preview-${kind}${open ? ' is-open' : ' is-collapsed'}`}>
      {kind === 'video' ? <video {...shared} playsInline /> : <audio {...shared} />}
      {!open && (
        <button type="button" className="media-preview-play" aria-label={`Play ${name}`} onClick={play}>
          <span aria-hidden="true">▶</span>
        </button>
      )}
    </div>
  )
}
