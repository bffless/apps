/**
 * The one module that imports Playwright — and it does so **lazily**, so the
 * unit suite (and `--help`) never pay for it and never launch a browser.
 *
 * The cast to `BrowserLike` is deliberate: Playwright's `Page.evaluate` is
 * generic in a way a hand-written interface cannot structurally satisfy, and a
 * single cast at the boundary is more honest than `any` spread through the
 * driver.
 */
import type { BrowserLike } from './page.js'

export interface LaunchOptions {
  headed?: boolean
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<BrowserLike> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    headless: options.headed !== true,
    // Required wherever unprivileged user namespaces are off (Ubuntu 24.04,
    // and most CI containers).
    args: ['--no-sandbox'],
    // Playwright's own SIGINT handler kills the browsers and calls
    // `process.exit(130)` immediately. That races the driver's Ctrl-C
    // contract — click Cancel, wait for the run to reach `cancelled`, *then*
    // exit 130 — and wins, so the run stayed `running` in CI's record and no
    // artifacts were written. The CLI owns SIGINT; SIGTERM/SIGHUP are left to
    // Playwright, which is the right cleanup for a signal we make no promises
    // about.
    handleSIGINT: false,
  })
  return browser as unknown as BrowserLike
}
