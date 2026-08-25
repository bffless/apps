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

  // ---------------------------------------------------------------------
  // Phase 2: the `card` job's script step ran in the Worker, uploaded its
  // poster Blob and offloaded its oversized `big` output.
  // ---------------------------------------------------------------------

  const drawStep = page.locator('[data-testid="step"][data-key="card/0/draw"]')
  await expect(drawStep).toHaveAttribute('data-state', 'succeeded', { timeout: 30_000 })

  // The Blob the module returned is a File ref by the time it is an output, and
  // a `file` output always offers Download (02).
  const posterDownload = outputs.locator('[data-output="poster"] .file-card-download')
  await expect(posterDownload).toHaveAttribute('href', /\/poster\.svg\?download=1$/)
  // …and the run-level `poster` is the very file the step recorded, not another
  // one that happens to be named the same.
  const posterHref = await posterDownload.getAttribute('href')
  await expect(
    outputs.locator('[data-output="card/0/draw.poster"] .file-card-download'),
  ).toHaveAttribute('href', posterHref!)

  // `ctx.log` (03: "shows in the step card") — the script step keeps the
  // ordinary tabs, and its log card rides on Details.
  await drawStep.click()
  const pane = page.getByTestId('step-pane')
  await pane.getByRole('tab', { name: 'Details' }).click()
  await expect(page.getByTestId('script-log')).toContainText('drawing')

  // `ctx.annotate` became a persisted `step.annotated`, so it is in the
  // run-level list beside the island's.
  await expect(page.getByTestId('annotations')).toContainText('card drawn')

  // Navigating away and back rebuilds the page client-side (the mock db is page
  // memory — a reload would take the live run's rows with it). Both the file
  // ref and the big value are still there afterwards.
  const runUrl = page.url()
  const runId = runUrl.split('/').pop()!
  await page.getByRole('link', { name: /past runs|runs/i }).first().click()
  await page.getByRole('link', { name: runId }).click()
  await expect(page).toHaveURL(runUrl)

  const outputsAgain = page.getByTestId('run-outputs')
  await expect(outputsAgain.locator('[data-output="poster"] .file-card-download')).toHaveAttribute(
    'href',
    /\/poster\.svg\?download=1$/,
  )
  // Not the value itself — it is ~400 KB, and the `json` viewer renders only
  // its first 200 entries. The array's own length is what the viewer's root
  // node reports, and only a value that is really there has one.
  await expect(outputsAgain.locator('[data-output="card/0/draw.big"]')).toContainText('[12000]')
})

/**
 * The read path (`getRun` → `hydrateOutputs` → `fetchPayload`), which no live
 * run can exercise: the seeded `interactive` record (`mocks/fixtures/scriptRun`)
 * holds its `big` output as a persisted `{"$file"}` pointer, so what the page
 * shows can only have come from fetching the object it points at.
 */
test('a recorded script run hydrates its {"$file"} payload on read', async ({ page }) => {
  await page.goto('/hello/interactive/runs/run_01hellofixturescript000000?mocks=on')

  const outputs = page.getByTestId('run-outputs')
  await expect(outputs).toBeVisible()

  // The row holds `{ $file: … }`; the marker only exists inside the object.
  await expect(outputs.locator('[data-output="card/0/draw.big"]')).toContainText(
    'hydrated-from-payload',
  )
  // A payload the fetch could not answer renders as this chip instead.
  await expect(page.getByTestId('payload-unavailable')).toHaveCount(0)

  await expect(outputs.locator('[data-output="poster"] .file-card-download')).toHaveAttribute(
    'href',
    /\/poster\.svg\?download=1$/,
  )
})
