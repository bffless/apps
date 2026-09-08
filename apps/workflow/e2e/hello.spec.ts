import { test, expect } from '@playwright/test'
import { waitStepState } from './steps'

test('hello workflow runs end to end against the mock backend', async ({ page }) => {
  await page.goto('/?mocks=on')
  await expect(page.getByTestId('implementations')).toContainText('hello')
  await page.getByRole('link', { name: /hello/i }).first().click()
  await expect(page.getByTestId('workflow-list')).toContainText('Hello workflow')
  // Scoped to the list, not `.first()`: the left rail (08's "implementation →
  // workflow tree") also renders a same-named link once discovery populates it,
  // so an unscoped locator is ambiguous by design, not by app defect.
  await page.getByTestId('workflow-list').getByRole('link', { name: 'Hello workflow' }).click()
  await expect(page.getByTestId('job').first()).toBeVisible()           // definition graph

  await page.getByRole('link', { name: /start a run/i }).click()
  await expect(page.getByTestId('kickoff-form')).toBeVisible()
  await page.getByTestId('kickoff-start').click()                        // defaults: Hello / [world]

  const status = page.getByTestId('run-status')
  await expect(status).toHaveAttribute('data-state', 'running')
  // greet succeeds, slow retries (mock BUSY) then polls to done, flaky fails-then-recovers,
  // confirm waits on the form. The wait is off the page contract (07), not the
  // Summary's graph chip: the moment the step waits, following auto-navigates
  // (replace) to its job page and the chip is gone (spec 2026-09-08).
  await waitStepState(page, 'confirm/0/review', 'waiting', 60_000)
  await page.getByRole('button', { name: 'Finish' }).click()             // the form step's submit label

  await expect(status).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 })
  const outputs = page.getByTestId('run-outputs')
  await expect(outputs).toContainText('report')
  await expect(outputs).toContainText('lines')
  await expect(outputs).toContainText('Hello, world!')                   // collected greet line
  // the flaky job's warning annotation surfaced (scoped: the same text is also
  // an output chip in run-outputs — the `after` step's own `note` output — so
  // an unscoped locator is ambiguous by design, not by app defect). The panel
  // is closed by default (no error-level annotation here), so open it first.
  await page.getByTestId('annotations').locator('summary').click()
  await expect(page.getByTestId('annotations').getByText(/boom failed with TEAPOT/)).toBeVisible()
  // and the run appears under Past runs:
  await page.getByRole('link', { name: /past runs|runs/i }).first().click()
  // Case-insensitive: `StatusPill` renders the human label ("Succeeded"),
  // capitalized on purpose (07's `data-state` carries the lowercase, driver-
  // read status; the label is for people) — not the machine value the brief
  // text literally spelled.
  await expect(page.getByRole('row').nth(1)).toContainText(/succeeded/i)
})
