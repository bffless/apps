/**
 * The public home page (Task 9/10): search over every published video's
 * transcript, and a RAG chat over the same library, sharing one player panel
 * that seeks to whichever moment the visitor picked. A Search|Chat tab bar
 * sits above the results. Search hands the panel a `{ youtubeId, startSec,
 * title }` (it already has the video title on hand); chat's citation chips
 * only carry `{ youtubeId, startSec }` (see `CitationChip`) — `title` is
 * optional on `PlayerTarget` so both feed the same state.
 */

import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { MomentChip, type Moment } from '../components/MomentChip'
import { SeekingPlayer } from '../components/SeekingPlayer'
import { ChatTab } from '../components/chat/ChatTab'
import type { SeekTarget } from '../components/CitationChip'
import { useSearchMutation, type SearchVideo } from '../store/searchApi'
import { useListPublicVideosQuery, type PublicVideoMeta } from '../store/videosApi'

type PlayerTarget = { youtubeId: string; startSec: number; title?: string }
type Tab = 'search' | 'chat'

const COLD_START_DELAY_MS = 2000

function errorInfo(error: unknown): { isRateLimited: boolean; message: string } {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status
    if (status === 429) {
      return { isRateLimited: true, message: "You're searching a bit fast — try again in a few minutes." }
    }
  }
  return { isRateLimited: false, message: "Search didn't work. Try again in a moment." }
}

function VideoResultCard({
  video,
  onSelectMoment,
}: {
  video: SearchVideo
  onSelectMoment: (video: SearchVideo, moment: Moment) => void
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex gap-4 p-4">
        <img
          src={`https://img.youtube.com/vi/${video.youtubeId}/hqdefault.jpg`}
          alt=""
          className="h-20 w-32 shrink-0 rounded object-cover"
          loading="lazy"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate font-medium text-slate-900 dark:text-slate-100">
              {video.title || 'Untitled video'}
            </h3>
            <a
              href={`https://www.youtube.com/watch?v=${video.youtubeId}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              Watch on YouTube ↗
            </a>
          </div>
          <div className="mt-1 space-y-0.5">
            {video.moments.map((moment, i) => (
              <MomentChip
                key={`${moment.start}-${i}`}
                moment={moment}
                sheetUrl={video.sheetUrl}
                sheetMeta={video.sheetMeta}
                onSelect={(m) => onSelectMoment(video, m)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ResultsSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex animate-pulse gap-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800"
        >
          <div className="h-20 w-32 shrink-0 rounded bg-slate-200 dark:bg-slate-800" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-1/2 rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-3 w-full rounded bg-slate-200 dark:bg-slate-800" />
            <div className="h-3 w-2/3 rounded bg-slate-200 dark:bg-slate-800" />
          </div>
        </div>
      ))}
    </div>
  )
}

function SearchTab({ onSelectMoment }: { onSelectMoment: (video: SearchVideo, moment: Moment) => void }) {
  const [q, setQ] = useState('')
  const [submittedQ, setSubmittedQ] = useState<string | null>(null)
  const [search, { data, isLoading, isError, error }] = useSearchMutation()
  const [showColdStartNote, setShowColdStartNote] = useState(false)

  // Not a useEffect: the "first search after idle can be slow" note is tied
  // to THIS submission's own timer, not a derived subscription on `isLoading`
  // — starting/canceling the timer directly in the event handler avoids the
  // set-state-in-effect footgun (an effect keyed on `isLoading` would need to
  // setState synchronously in its own body to clear the note, which is
  // exactly the cascading-render pattern that hook guards against).
  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = q.trim()
    if (!trimmed) return
    setSubmittedQ(trimmed)
    setShowColdStartNote(false)
    const timer = setTimeout(() => setShowColdStartNote(true), COLD_START_DELAY_MS)
    try {
      await search({ q: trimmed }).unwrap()
    } catch {
      // Error state is already surfaced via the mutation's own `isError`/`error`.
    } finally {
      clearTimeout(timer)
      setShowColdStartNote(false)
    }
  }

  const videos = data?.videos ?? []
  const { isRateLimited, message } = isError ? errorInfo(error) : { isRateLimited: false, message: '' }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search video transcripts…"
          aria-label="Search video transcripts"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <button
          type="submit"
          disabled={isLoading || !q.trim()}
          className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="mt-6">
        {isLoading && (
          <>
            <ResultsSkeleton />
            {showColdStartNote && (
              <p className="mt-3 text-center text-xs text-slate-400 dark:text-slate-500">
                First search after a while can take a few seconds to warm up.
              </p>
            )}
          </>
        )}

        {!isLoading && isError && (
          <p
            role="alert"
            className={
              isRateLimited
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-red-600 dark:text-red-400'
            }
          >
            {message}
          </p>
        )}

        {!isLoading && !isError && submittedQ === null && (
          <p className="text-slate-500 dark:text-slate-400">
            Search across every published video's transcript.
          </p>
        )}

        {!isLoading && !isError && submittedQ !== null && videos.length === 0 && (
          <p className="text-slate-500 dark:text-slate-400">
            No matches for &ldquo;{submittedQ}&rdquo;. Try different words.
          </p>
        )}

        {!isLoading && !isError && videos.length > 0 && (
          <div className="space-y-3">
            {videos.map((video) => (
              <VideoResultCard key={video.videoId} video={video} onSelectMoment={onSelectMoment} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function LibraryCard({ video }: { video: PublicVideoMeta }) {
  return (
    <Link
      to={`/video/${video.videoId}`}
      className="group overflow-hidden rounded-lg border border-slate-200 transition-colors hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700"
    >
      <div className="relative aspect-video w-full overflow-hidden bg-slate-100 dark:bg-slate-800">
        <img
          src={`https://img.youtube.com/vi/${video.youtubeId}/hqdefault.jpg`}
          alt=""
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
          loading="lazy"
        />
        {video.duration > 0 && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
            {formatMMSS(video.duration)}
          </span>
        )}
      </div>
      <div className="p-3">
        <h3 className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {video.title || 'Untitled video'}
        </h3>
      </div>
    </Link>
  )
}

function LibrarySkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4"
      aria-hidden="true"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse space-y-2">
          <div className="aspect-video w-full rounded-lg bg-slate-200 dark:bg-slate-800" />
          <div className="h-4 w-3/4 rounded bg-slate-200 dark:bg-slate-800" />
        </div>
      ))}
    </div>
  )
}

function LibrarySection() {
  const { data, isLoading, isError } = useListPublicVideosQuery()
  const videos = data?.videos ?? []

  return (
    <section className="mt-12 border-t border-slate-200 pt-8 dark:border-slate-800">
      <h2 className="mb-4 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Library
      </h2>

      {isLoading && <LibrarySkeleton />}

      {!isLoading && isError && (
        <p className="text-red-600 dark:text-red-400">Couldn't load the library. Try refreshing.</p>
      )}

      {!isLoading && !isError && videos.length === 0 && (
        <p className="text-slate-500 dark:text-slate-400">No published videos yet.</p>
      )}

      {!isLoading && !isError && videos.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {videos.map((video) => (
            <LibraryCard key={video.videoId} video={video} />
          ))}
        </div>
      )}
    </section>
  )
}

export function Home() {
  const [tab, setTab] = useState<Tab>('search')
  const [player, setPlayer] = useState<PlayerTarget | null>(null)
  // Gates `SeekingPlayer`'s `autoplay` (PR-feedback-2). The player panel here
  // only ever mounts as the direct result of a moment/citation click, so this
  // is always `true` by the time `player` goes non-null — kept explicit
  // (rather than hard-coding `autoplay` on the panel) for the same
  // "only autoplay off a real user gesture" reasoning as `Video.tsx`.
  const [hasUserSeeked, setHasUserSeeked] = useState(false)

  function handleSelectMoment(video: SearchVideo, moment: Moment) {
    setPlayer({ youtubeId: video.youtubeId, startSec: moment.start, title: video.title })
    setHasUserSeeked(true)
  }

  function handleSeek(target: SeekTarget) {
    setPlayer(target)
    setHasUserSeeked(true)
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          Recall
        </h1>
        <p className="mt-1 text-slate-500 dark:text-slate-400">
          Video transcript search & chat.
        </p>
      </header>

      {player && (
        <div className="mb-8">
          <SeekingPlayer
            youtubeId={player.youtubeId}
            startSec={player.startSec}
            title={player.title}
            autoplay={hasUserSeeked}
          />
        </div>
      )}

      <div role="tablist" aria-label="Search or chat" className="mb-6 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {(['search', 'chat'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={
              'border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors ' +
              (tab === t
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200')
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'search' ? <SearchTab onSelectMoment={handleSelectMoment} /> : <ChatTab onSeek={handleSeek} />}

      <LibrarySection />
    </div>
  )
}
