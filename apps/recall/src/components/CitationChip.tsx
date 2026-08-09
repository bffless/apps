/**
 * Task 10: renders a single `<a>` from the chat markdown renderer. A citation
 * link the assistant produces (per the chat rule's system prompt) looks like
 * `[<video title> @ <mm:ss>](https://www.youtube.com/watch?v=<id>&t=<sec>s)`
 * — when the href resolves to a YouTube video id we render it as a clickable
 * chip that seeks the shared player instead of navigating away; every other
 * link (docs, external sites, or a markdown edge case with no href at all)
 * falls back to a plain new-tab anchor.
 */

import { extractYouTubeId, extractYouTubeTimestamp } from '../lib/youtube'

export type SeekTarget = { youtubeId: string; startSec: number }

type CitationChipProps = {
  href?: string
  onSeek: (target: SeekTarget) => void
  children?: React.ReactNode
}

export function CitationChip({ href, onSeek, children }: CitationChipProps) {
  const youtubeId = href ? extractYouTubeId(href) : null

  if (!youtubeId) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline hover:no-underline dark:text-blue-400">
        {children}
      </a>
    )
  }

  const startSec = extractYouTubeTimestamp(href!) ?? 0

  return (
    <button
      type="button"
      onClick={() => onSeek({ youtubeId, startSec })}
      className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800"
    >
      {children}
    </button>
  )
}
