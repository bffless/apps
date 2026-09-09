import type { Page } from '@playwright/test'

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
 * `runUrl` is the Summary URL. Confirms arrival on the step's own pane, not a
 * chip — the interim job page (phase 1) renders no `[data-testid="step"]` row
 * of its own (that lives only on the Summary's graph); the pane is the one
 * DOM anchor common to every phase's job route.
 */
export async function openStep(page: Page, runUrl: string, key: string) {
  const [job, index] = key.split('/')
  const url = new URL(runUrl)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/job/${encodeURIComponent(job!)}/${index}`
  url.searchParams.set('step', key)
  await page.goto(url.toString(), { waitUntil: 'networkidle' })
  await page.getByTestId('step-pane').waitFor()
}
