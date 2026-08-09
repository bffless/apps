/**
 * Embeds a YouTube video seeked to a specific transcript moment (Task 9).
 * The iframe's `key` incorporates both `youtubeId` and `startSec` so React
 * fully remounts it on every seek — YouTube's embed API doesn't apply a new
 * `start` query param to an already-loaded player, so swapping `src` alone
 * would leave playback wherever it already was.
 */

type SeekingPlayerProps = {
  youtubeId: string
  startSec: number
  title?: string
}

export function SeekingPlayer({ youtubeId, startSec, title }: SeekingPlayerProps) {
  const rounded = Math.round(startSec)
  const src = `https://www.youtube-nocookie.com/embed/${youtubeId}?start=${rounded}&autoplay=1`

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
