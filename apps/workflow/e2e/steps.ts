import type { Page } from '@playwright/test'

/**
 * Wait for a step's status off the page contract (07): `window.__workflow.steps[key]`,
 * not a DOM query — the step's row lives on the job page (spec 2026-09-08, phase 3),
 * reached by URL, so it may not be the page currently mounted.
 */
export function waitStepState(page: Page, key: string, want: string, timeout: number) {
  return page.waitForFunction(
    ([k, w]) => (window as unknown as { __workflow?: { steps?: Record<string, string> } }).__workflow?.steps?.[k] === w,
    [key, want] as const,
    { timeout },
  )
}
