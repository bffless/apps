import type { Page } from 'playwright'

/** Wait for a step's status off the page contract (07) — the DOM row may be on another page. */
export function waitStepState(page: Page, key: string, want: string, timeout: number) {
  return page.waitForFunction(
    ([k, w]) => (window as unknown as { __workflow?: { steps?: Record<string, string> } }).__workflow?.steps?.[k] === w,
    [key, want] as const,
    { timeout },
  )
}

/** Split a step key `"<job>/<index>/<stepId>"` into its rail/row parts. */
export function parseStepKey(key: string): { job: string; index: string; stepId: string } {
  const [job, index, stepId] = key.split('/')
  return { job: job ?? '', index: index ?? '0', stepId: stepId ?? '' }
}

/**
 * Open a step's row by navigating **in-page** (spec 2026-09-08) — never a
 * `page.goto`. A page driving a run demotes itself to a mere observer on any
 * full navigation ("Another tab is driving this run. Take over…"): the fresh
 * load re-hydrates from the server record, which can still lag what the
 * driving tab just did in-page (Task 16b — `openStep` used to `goto` the
 * step's `?step=` URL, and against the live harness that raced the record:
 * the reloaded page observed `card` still `running` and `review/0/confirm`
 * still `queued`, and `form-step` never appeared). A tab that only
 * *observes* a run may reach a step by loading its URL; the tab *driving*
 * the run must click there, the way a reader would — the rail's job (or
 * matrix item) row, then the step's own row head, which expands its pane in
 * place.
 */
export async function openStep(page: Page, key: string) {
  const { job, index } = parseStepKey(key)
  // `.first()` on every use of the row, not just the guarded one — defensively,
  // not because a second match is reachable today: `getAttribute` and `click`
  // are strict, so any future shape that put two elements on one step key would
  // fail the walk with a strict-mode violation rather than open the step. (The
  // two candidates are not it. The fullscreen overlay does not clone the row —
  // it fixes the run canvas over the viewport and keeps the *same* `<li>`,
  // marked `data-fullscreen` — and the workflow page's declared rows live on
  // `/<impl>/<workflow>`, which no run route renders.) The row the page means
  // is always the first in document order.
  const row = page.locator(`[data-testid="step"][data-key="${key}"]`).first()
  const alreadyOpen = (await row.count()) > 0 && (await row.getAttribute('aria-expanded').catch(() => null)) === 'true'
  if (!alreadyOpen) {
    const rail = page.locator('nav[aria-label="Run"]')
    const matrixGroup = rail.locator(`[data-testid="rail-matrix"][data-job="${job}"]`)
    if (await matrixGroup.count()) {
      const itemLink = matrixGroup.locator(`[data-testid="rail-job"][data-job="${job}"][data-index="${index}"]`)
      if (!(await itemLink.isVisible().catch(() => false))) {
        await matrixGroup.locator('button[aria-expanded="false"]').click()
      }
      await itemLink.click()
    } else {
      await rail.locator(`[data-testid="rail-job"][data-job="${job}"]:not([data-index])`).click()
    }
    await row.waitFor()
    if ((await row.getAttribute('aria-expanded')) !== 'true') {
      await row.click()
    }
  }
  await page.locator(`li:has([data-testid="step"][data-key="${key}"])`).first().getByTestId('step-pane').waitFor()
}
