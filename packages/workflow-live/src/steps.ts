import type { Page } from 'playwright'

/** Wait for a step's status off the page contract (07) — the DOM row may be on another page. */
export function waitStepState(page: Page, key: string, want: string, timeout: number) {
  return page.waitForFunction(
    ([k, w]) => (window as unknown as { __workflow?: { steps?: Record<string, string> } }).__workflow?.steps?.[k] === w,
    [key, want] as const,
    { timeout },
  )
}

/**
 * Open a step's row: navigate to its job page with `?step=` (spec 2026-09-08).
 * `runUrl` is the Summary URL. A full navigation is fine here — unlike the
 * in-repo e2e specs (whose mock backend lives in page memory, so a reload
 * would lose the live run), a live deployment's run is server-side state; a
 * fresh load just re-hydrates the same run at the step's own route.
 */
export async function openStep(page: Page, runUrl: string, key: string) {
  const [job, index] = key.split('/')
  const url = new URL(runUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/job/${encodeURIComponent(job!)}/${index}`
  url.searchParams.set('step', key)
  await page.goto(url.toString(), { waitUntil: 'networkidle' })
  await page.locator(`[data-testid="step"][data-key="${key}"][aria-expanded="true"]`).waitFor()
  await page.getByTestId('step-pane').waitFor()
}
