/**
 * Embeds a YouTube video seeked to a specific transcript moment (Task 9).
 * The iframe's `key` incorporates `youtubeId`, `startSec`, AND `nonce` so
 * React fully remounts it on every seek — YouTube's embed API doesn't apply
 * a new `start` query param to an already-loaded player, so swapping `src`
 * alone would leave playback wherever it already was.
 *
 * PR-feedback-6 bugfix: `nonce` exists because `youtubeId`+`startSec` alone
 * under-specifies "a seek happened" — clicking a SECOND citation/moment/
 * transcript span that names the exact same `{youtubeId, startSec}` as the
 * current player state is a real, common case (a chat reply citing the same
 * timestamp twice; re-clicking a moment after playback has drifted forward),
 * and it used to be a silent no-op: identical props meant an identical React
 * key, so no remount, no re-seek. Callers own a monotonic counter and bump
 * it on EVERY seek (even to an already-current time) — see `Home.tsx`'s
 * `PlayerTarget.nonce` and `Video.tsx`'s `seekNonce`.
 *

 * Uses the standard `youtube.com/embed` domain, not `youtube-nocookie.com`
 * (PR-feedback-2): live-testing feedback showed common ad/privacy blockers
 * flag `youtube-nocookie.com` frames outright (a gray net-error box, not a
 * degraded-but-working embed), which would break the player for real
 * visitors running that tooling — the opposite of what the "privacy-
 * enhanced" domain is supposed to buy.
 *
 * `autoplay` defaults to `false`: only pass `true` when this mount is the
 * direct result of a user action (a transcript/citation/moment click) — see
 * `Video.tsx` and `Home.tsx`'s `hasUserSeeked` flags. Autoplaying on a bare
 * page load (no prior user gesture) gets throttled by the browser anyway and
 * reads as another blocker false-positive.
 */

type SeekingPlayerProps = {
  youtubeId: string
  startSec: number
  /** Monotonic seek counter — bump on every seek, even a repeat of the same
   * `{youtubeId, startSec}`, so the player remounts (see the module doc). */
  nonce?: number
  title?: string
  autoplay?: boolean
}

export function SeekingPlayer({ youtubeId, startSec, nonce = 0, title, autoplay = false }: SeekingPlayerProps) {
  const rounded = Math.round(startSec)
  const src = `https://www.youtube.com/embed/${youtubeId}?start=${rounded}&autoplay=${autoplay ? 1 : 0}`

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
      <iframe
        key={`${youtubeId}-${startSec}-${nonce}`}
        src={src}
        title={title || 'Video player'}
        className="h-full w-full"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </div>
  )
}
