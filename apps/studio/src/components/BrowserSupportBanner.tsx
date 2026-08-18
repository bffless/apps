import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { getResolvedVideoBackend, subscribeVideoBackend } from '../lib/videoBackend'

/**
 * Warns non-Firefox visitors that Studio's IN-BROWSER video processing
 * (ffmpeg.wasm core-mt) currently fails outside Firefox — Chrome hits an ffmpeg
 * issue. It only matters when video ops actually run in the tab, so the banner
 * is gated on the resolved video backend being `wasm` (`lib/videoBackend.ts`):
 * on a server-side backend (Local server / Remote / Server (auto)) ffmpeg never
 * runs in the browser and the warning would be noise. Hidden while resolving,
 * re-resolved on route changes (the probe is session-gated, so a cold pre-login
 * visit resolves wasm until the user signs in and opens a project) and on
 * picker changes. Browser detection is UA-based on purpose: we're gating on the
 * browser family, not a feature we can probe.
 */
export function BrowserSupportBanner() {
  const [dismissed, setDismissed] = useState(false)
  const [wasm, setWasm] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => {
    let live = true
    const load = () => {
      void getResolvedVideoBackend().then((r) => {
        if (live) setWasm(r.backend === 'wasm')
      })
    }
    load()
    const unsub = subscribeVideoBackend(load)
    return () => {
      live = false
      unsub()
    }
  }, [pathname])

  if (dismissed || !wasm || /firefox/i.test(navigator.userAgent)) return null
  return (
    <div role="alert" className="border-b border-amber-300 bg-amber-50 text-amber-900">
      <div className="container-page flex items-start gap-3 py-2.5 text-[13px] leading-snug sm:items-center">
        <p className="flex-1">
          <strong className="font-semibold">Firefox required:</strong> Studio&rsquo;s in-browser video
          processing (ffmpeg.wasm) currently fails in Chrome and other browsers. Open this app in
          Firefox, or pick a server video backend if your instance offers one.
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss browser warning"
          className="shrink-0 rounded p-1 text-amber-700 hover:bg-amber-100 hover:text-amber-900"
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
