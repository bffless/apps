/**
 * The public home page (Task 9/10): search over every published video's
 * transcript, and a RAG chat over the same library, sharing one player panel
 * that seeks to whichever moment the visitor picked. A Search|Chat tab bar
 * sits above the results. Search hands the panel a `{ youtubeId, startSec,
 * title }` (it already has the video title on hand); chat's citation chips
 * only carry `{ youtubeId, startSec }` (see `CitationChip`) — `title` is
 * optional on `PlayerTarget` so both feed the same state.
 *
 * PR-feedback-6: the search box and active tab sync to the URL
 * (`?q=<query>`, `?tab=chat`) via `useSearchParams`, so a refresh or a
 * shared link restores state. Search submissions PUSH a new history entry
 * (so the back button walks search history, one query per entry); tab
 * switches REPLACE (switching tabs isn't a "back" stop) — see `SearchTab`
 * and `Home`'s `handleTabClick` respectively.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { MomentChip, type Moment } from '../components/MomentChip'
import { SeekingPlayer } from '../components/SeekingPlayer'
import { ChatTab } from '../components/chat/ChatTab'
import type { SeekTarget } from '../components/CitationChip'
import { useSearchMutation, type SearchVideo } from '../store/searchApi'
import { useListPublicVideosQuery, type PublicVideoMeta } from '../store/videosApi'

// `nonce` (PR-feedback-6 bugfix): a monotonic counter, bumped on EVERY seek
// — including a repeat seek to the exact same `{youtubeId, startSec}` (a
// chat reply citing the same timestamp twice, or re-clicking a moment after
// playback has drifted forward). Without it, `SeekingPlayer`'s remount key
// is unchanged and the second click is a silent no-op. See
// `SeekingPlayer.tsx`'s own doc comment for the full story.
type PlayerTarget = { youtubeId: string; startSec: number; title?: string; nonce: number }
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
        <Link to={`/video/${video.videoId}`} className="shrink-0">
          <img
            src={`https://img.youtube.com/vi/${video.youtubeId}/hqdefault.jpg`}
            alt=""
            className="h-20 w-32 rounded object-cover"
            loading="lazy"
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate font-medium text-slate-900 dark:text-slate-100">
              <Link to={`/video/${video.videoId}`} className="hover:underline">
                {video.title || 'Untitled video'}
              </Link>
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

/**
 * `?q=` sync (PR-feedback-6): `initialQ` is read ONCE at mount (a `useState`
 * initializer, not a live subscription — the URL can keep changing after
 * that, e.g. via `setSearchParams` below, without re-triggering this).
 * Submitting a NEW search always PUSHes (`push: true`, the default for
 * `setSearchParams` with no `replace` option) — one history entry per query,
 * so the back button walks search history, per the brief. The mount-time
 * auto-run (below) passes `push: false`: the URL already has this `q`, from
 * whoever loaded/shared this link, so re-pushing it would just create a
 * pointless duplicate history entry.
 */
function SearchTab({
  onSelectMoment,
  searchParams,
  setSearchParams,
}: {
  onSelectMoment: (video: SearchVideo, moment: Moment) => void
  searchParams: URLSearchParams
  setSearchParams: ReturnType<typeof useSearchParams>[1]
}) {
  const [initialQ] = useState(() => searchParams.get('q') ?? '')
  const [q, setQ] = useState(initialQ)
  // Lazily seeded from `initialQ` (not set inside an effect — see the
  // mount-time auto-run below): if the page loaded with `?q=`, the results
  // shell should already read as "a search happened" on the very first
  // render, same as right after a manual submit.
  const [submittedQ, setSubmittedQ] = useState<string | null>(() => (initialQ.trim() ? initialQ.trim() : null))
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
    // A NEW submission always pushes a fresh history entry — one per query,
    // so the back button walks search history.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('q', trimmed)
      return next
    })
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

  // Auto-run once on mount if the page loaded with a `?q=` already set (a
  // refresh or a shared link). This effect does NOT call any local setState
  // (`submittedQ` is already seeded above, via the lazy initializer) —
  // it only dispatches the RTK Query mutation itself, so it doesn't trip
  // react-hooks' "no setState synchronously in an effect body" rule. No
  // `setSearchParams` push either: the URL already has this `q`, so
  // re-pushing it would just create a pointless duplicate history entry.
  useEffect(() => {
    if (initialQ.trim()) {
      void search({ q: initialQ.trim() })
    }
    // Runs once on mount only: `initialQ` never changes after mount (a
    // useState initializer), and `search`'s identity is stable (an RTK
    // Query mutation trigger).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  const [searchParams, setSearchParams] = useSearchParams()
  // `?tab=chat` sync: read once at mount (same lazy-initializer pattern as
  // `SearchTab`'s `initialQ`), any other/missing value defaults to 'search'.
  const [tab, setTabState] = useState<Tab>(() => (searchParams.get('tab') === 'chat' ? 'chat' : 'search'))
  const [player, setPlayer] = useState<PlayerTarget | null>(null)
  // Gates `SeekingPlayer`'s `autoplay` (PR-feedback-2). The player panel here
  // only ever mounts as the direct result of a moment/citation click, so this
  // is always `true` by the time `player` goes non-null — kept explicit
  // (rather than hard-coding `autoplay` on the panel) for the same
  // "only autoplay off a real user gesture" reasoning as `Video.tsx`.
  const [hasUserSeeked, setHasUserSeeked] = useState(false)
  // A plain mutable counter (not state) — every seek reads-then-increments
  // it synchronously, so two seeks in the same tick still get distinct
  // nonces (a functional `setPlayer` updater reading `prev.nonce` would work
  // too, but this is simpler and doesn't require plumbing every call site
  // through a callback form).
  const seekNonceRef = useRef(0)
  function nextSeekNonce(): number {
    seekNonceRef.current += 1
    return seekNonceRef.current
  }

  // Tab switches REPLACE (not push): flipping between Search and Chat isn't
  // a "back" stop the way a new search query is. Drops `tab` from the URL
  // entirely when switching back to 'search' (the default), so a plain
  // `/` stays the canonical search-tab URL rather than always carrying
  // `?tab=search`.
  function handleTabClick(next: Tab) {
    setTabState(next)
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (next === 'chat') params.set('tab', 'chat')
        else params.delete('tab')
        return params
      },
      { replace: true },
    )
  }

  function handleSelectMoment(video: SearchVideo, moment: Moment) {
    setPlayer({ youtubeId: video.youtubeId, startSec: moment.start, title: video.title, nonce: nextSeekNonce() })
    setHasUserSeeked(true)
  }

  function handleSeek(target: SeekTarget) {
    setPlayer({ ...target, nonce: nextSeekNonce() })
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
            nonce={player.nonce}
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
            onClick={() => handleTabClick(t)}
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

      {tab === 'search' ? (
        <SearchTab
          onSelectMoment={handleSelectMoment}
          searchParams={searchParams}
          setSearchParams={setSearchParams}
        />
      ) : (
        <ChatTab onSeek={handleSeek} />
      )}

      <LibrarySection />
    </div>
  )
}
