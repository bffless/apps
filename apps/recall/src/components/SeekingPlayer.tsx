/**
 * Embeds a YouTube video seeked to a specific transcript moment (Task 9).
 * The iframe's `key` incorporates both `youtubeId` and `startSec` so React
 * fully remounts it on every seek — YouTube's embed API doesn't apply a new
 * `start` query param to an already-loaded player, so swapping `src` alone
 * would leave playback wherever it already was.
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
  title?: string
  autoplay?: boolean
}

export function SeekingPlayer({ youtubeId, startSec, title, autoplay = false }: SeekingPlayerProps) {
  const rounded = Math.round(startSec)
  const src = `https://www.youtube.com/embed/${youtubeId}?start=${rounded}&autoplay=${autoplay ? 1 : 0}`

  return (
    <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
      <iframe
        key={`${youtubeId}-${startSec}`}
        src={src}
        title={title || 'Video player'}
        className="h-full w-full"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </div>
  )
}
