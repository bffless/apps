import { test, expect } from '@playwright/test'

test('interactive hello runs an island step end to end against the mock backend', async ({
  page,
}) => {
  await page.goto('/?mocks=on')
  await expect(page.getByTestId('implementations')).toContainText('hello')
  await page.getByRole('link', { name: /hello/i }).first().click()
  await expect(page.getByTestId('workflow-list')).toContainText('Interactive hello')
  // Scoped to the list: the M1 "Hello workflow" and M2 "Interactive hello" both
  // live under the same `hello` implementation, so an unscoped locator would
  // be ambiguous once the left rail also picks up the same-named link.
  await page.getByTestId('workflow-list').getByRole('link', { name: 'Interactive hello' }).click()
  await expect(page.getByTestId('step').first()).toBeVisible() // definition graph

  await page.getByRole('link', { name: /start a run/i }).click()
  await expect(page.getByTestId('kickoff-form')).toBeVisible()
  await page.getByTestId('kickoff-start').click() // defaults: greeting=Hello, names=[world, studio]

  const status = page.getByTestId('run-status')
  await expect(status).toHaveAttribute('data-state', 'running')

  // greet fans out over the matrix, analyze runs, then the island step opens
  // its pane and cannot reach `waiting` until the pane (and thus the iframe)
  // has rendered — never assert `running` here (task-7-report).
  const chooseStep = page.locator('[data-testid="step"][data-key="pick/0/choose"]')
  await expect(chooseStep).toHaveAttribute('data-state', 'waiting', { timeout: 60_000 })

  // `island-frame` is not unique on RunPage: the `render: island` viewer for
  // the run's `view` output also renders one, from first paint. Scope to the
  // step's own pane display.
  const stepFrame = page
    .locator('[data-testid="island-display"] [data-testid="island-frame"]')
    .contentFrame()

  // Proves the whole `with` (both `lines` and `words`) arrived as tool input.
  await expect(stepFrame.getByTestId('words')).toContainText('2 lines · 4 words')

  const firstLine = stepFrame.getByTestId('line').first()
  await expect(firstLine).toContainText('Hello, world!')
  await firstLine.click()

  // The `echo` pipeline round-trip, shouted back through the island.
  await expect(stepFrame.getByTestId('shouted')).toContainText('HELLO, WORLD!')

  // The deliberate rejection path: `workflow.submit` with `{}` fails required
  // validation and the step stays `waiting`, not `failed`.
  await stepFrame.getByTestId('submit-nothing').click()
  await expect(stepFrame.getByTestId('submit-error')).toContainText('This field is required')
  await expect(chooseStep).toHaveAttribute('data-state', 'waiting')

  await stepFrame.getByTestId('submit').click()

  await expect(status).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 })

  const outputs = page.getByTestId('run-outputs')
  await expect(outputs).toContainText('line')
  await expect(outputs).toContainText('Hello, world!')

  // The `render: island` viewer for the `view` output — a second, distinct
  // `island-frame`, scoped by its renderer wrapper this time.
  const viewerFrame = page
    .locator('[data-testid="renderer"][data-render="island"] [data-testid="island-frame"]')
    .contentFrame()
  await expect(viewerFrame.getByTestId('viewer-value')).toContainText('"line"')
  await expect(viewerFrame.getByTestId('viewer-value')).toContainText('Hello, world!')

  // The live `workflow.annotate` call the preview made (Decision 12: a step's
  // annotation becomes a persisted `step.annotated` event) surfaces in the
  // run-level annotations list.
  await expect(page.getByTestId('annotations')).toContainText('Previewed Hello, world!')
})
