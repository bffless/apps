/**
 * Embed mode — a chromeless viewer layout for `?embed=1`.
 *
 * When Handoff is iframed by an RSS reader to show a markdown post's body
 * inline, `?embed=1` suppresses ALL app chrome (the Shell header + sidebar and
 * the viewer's control bar + details block), leaving only the rendered content.
 * It is a pure layout flag: the underlying rendering, share-token claim, and
 * data fetching are unchanged.
 *
 * Both the outer `Shell` (App.tsx) and the inner `ViewerBody`
 * (HandoffViewer.tsx) read this so the two chrome layers are gated in lockstep.
 */
import { useSearchParams } from 'react-router-dom'

/** True when the current URL carries `?embed=1` — render chromeless. */
export function useEmbedMode(): boolean {
  const [searchParams] = useSearchParams()
  return searchParams.get('embed') === '1'
}
