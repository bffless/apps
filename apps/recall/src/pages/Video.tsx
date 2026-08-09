/**
 * Public video/transcript page (Task 11): `SeekingPlayer` at the top, a
 * click-to-seek `TranscriptView` below it, sharing the same seek mechanism
 * Home's search/chat tabs use — `SeekingPlayer` remounts on `startSec`
 * change (see its own header comment), so clicking a transcript span just
 * bumps local state.
 *
 * `?t=<seconds>` deep-links to a moment (the same query param
 * `youTubeDeepLink`/`extractYouTubeTimestamp` in `src/lib/youtube.ts` use
 * for chat citations), read once at mount as the player's initial position.
 *
 * `hasUserSeeked` (PR-feedback-2) gates `SeekingPlayer`'s `autoplay`: the
 * very first mount — whether at `startSec=0` or at a `?t=` deep link — is
 * NOT a user gesture, so it renders paused (autoplay would get throttled by
 * the browser and read as another blocker false-positive anyway). Only a
 * transcript click flips it on, autoplaying from then on.
 *
 * `activeSec` tracking limitation: the plain `youtube.com/embed` iframe here
 * carries no JS API, so there's no live playhead to read. `activeSec` is
 * therefore only ever the last second the visitor explicitly seeked to
 * (via a transcript click or the initial `?t=`) — TranscriptView highlights
 * whichever span contains THAT second, not "wherever the video actually is
 * right now" as it silently plays on. Post-v1: swap the plain iframe for
 * the YouTube iframe API to get real playhead events.
 *
 * `seekNonce` (PR-feedback-6 bugfix): bumped on EVERY `handleSeek` call,
 * including a repeat click on the SAME transcript span (the same
 * {startSec} as the current player state) — without it, `SeekingPlayer`'s
 * remount key doesn't change and the repeat click silently does nothing,
 * even though playback has moved on since the first click. See
 * `SeekingPlayer.tsx`'s own doc comment for the full story.
 */

import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { SeekingPlayer } from '../components/SeekingPlayer'
import { TranscriptView } from '../components/TranscriptView'
import { useGetPublicVideoQuery, type PublicVideo } from '../store/videosApi'

function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function NotFoundVideo() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-20 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Video not found
      </h1>
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        This video doesn't exist or hasn't been published yet.
      </p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Back to Recall
      </Link>
    </div>
  )
}

function VideoPage({ video }: { video: PublicVideo }) {
  const [searchParams] = useSearchParams()
  const rawT = Number(searchParams.get('t'))
  const initialStartSec = Number.isFinite(rawT) && rawT > 0 ? rawT : 0

  const [startSec, setStartSec] = useState(initialStartSec)
  const [activeSec, setActiveSec] = useState<number | undefined>(
    initialStartSec > 0 ? initialStartSec : undefined,
  )
  // Gates `SeekingPlayer`'s `autoplay` — false on the initial mount (page
  // load, even at a `?t=` deep link) since that's not a user gesture; a
  // transcript click flips it on for good.
  const [hasUserSeeked, setHasUserSeeked] = useState(false)
  // Monotonic seek counter (PR-feedback-6 bugfix) — see the module doc.
  const [seekNonce, setSeekNonce] = useState(0)

  function handleSeek(sec: number) {
    setStartSec(sec)
    setActiveSec(sec)
    setHasUserSeeked(true)
    setSeekNonce((n) => n + 1)
  }

  const words = video.transcript.words

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      {video.youtubeId ? (
        <div className="mb-6">
          <SeekingPlayer
            youtubeId={video.youtubeId}
            startSec={startSec}
            nonce={seekNonce}
            title={video.title}
            autoplay={hasUserSeeked}
          />
        </div>
      ) : (
        <p className="mb-6 text-sm text-red-600 dark:text-red-400">
          This video doesn't have a playable YouTube link.
        </p>
      )}

      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            {video.title || 'Untitled video'}
          </h1>
          {video.description && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{video.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>{formatMMSS(video.duration)}</span>
          {video.youtubeId && (
            <a
              href={`https://www.youtube.com/watch?v=${video.youtubeId}`}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Watch on YouTube ↗
            </a>
          )}
        </div>
      </header>

      {words.length > 0 ? (
        <TranscriptView words={words} onSeek={handleSeek} activeSec={activeSec} />
      ) : (
        <p className="text-slate-500 dark:text-slate-400">No transcript available.</p>
      )}
    </div>
  )
}

export function Video() {
  const { videoId } = useParams<{ videoId: string }>()
  const { data, isLoading, isError } = useGetPublicVideoQuery(videoId ?? '', { skip: !videoId })

  if (!videoId) return null

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 text-slate-500 dark:text-slate-400">
        Loading…
      </div>
    )
  }

  if (isError || !data) {
    return <NotFoundVideo />
  }

  // Key on videoId so navigating between two videos at the same route (a
  // library card link) gets a fresh player/transcript state instead of
  // stale seek position carried over from the previous video.
  return <VideoPage key={data.video.videoId} video={data.video} />
}
