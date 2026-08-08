import { useState } from 'react'

/**
 * Warns non-Firefox visitors that Studio's video processing (ffmpeg.wasm
 * core-mt) currently fails outside Firefox — Chrome hits an ffmpeg issue, so
 * the export pipeline only works in Firefox. Detection is UA-based on purpose:
 * we're gating on the browser family, not a feature we can probe.
 */
export function BrowserSupportBanner() {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || /firefox/i.test(navigator.userAgent)) return null
  return (
    <div role="alert" className="border-b border-amber-300 bg-amber-50 text-amber-900">
      <div className="container-page flex items-start gap-3 py-2.5 text-[13px] leading-snug sm:items-center">
        <p className="flex-1">
          <strong className="font-semibold">Firefox required:</strong> Studio&rsquo;s video
          processing (ffmpeg) currently fails in Chrome and other browsers. Please open this app in
          Firefox.
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
