import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

/**
 * The bytes the `review` form's mid-run `file` field uploads: a 1×1 PNG, small
 * enough to commit and real enough that `accept: image/*` lets it through.
 */
const EXTRA_PNG = fileURLToPath(new URL('./fixtures/extra.png', import.meta.url))

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

  // ---------------------------------------------------------------------
  // Phase 3: the `review` job's form step — the last thing between the run
  // and `succeeded`, which is why it is filled in *here* rather than after
  // the assertions below (everything past this point is unchanged).
  // ---------------------------------------------------------------------

  const confirmStep = page.locator('[data-testid="step"][data-key="review/0/confirm"]')
  await expect(confirmStep).toHaveAttribute('data-state', 'waiting', { timeout: 60_000 })
  // The pane auto-opens only when nothing else is selected, and the island
  // step still is (RunPage's "never fight a selection back over") — so the
  // way to the form is the same click a reader would make.
  await confirmStep.click()
  const form = page.getByTestId('form-step')
  await expect(form).toBeVisible()

  // `options: ${{ needs.card.outputs.posters }}` is a list of File refs, so
  // `cover` renders as the tile picker (02's shorthand) — one tile, because
  // the script returned one poster.
  const tiles = form.getByTestId('tile-picker').getByTestId('tile')
  await expect(tiles).toHaveCount(1)
  await tiles.first().click()
  await expect(tiles.first()).toHaveAttribute('aria-checked', 'true')

  // The `markdown` field's preview renders the *evaluated* default — the
  // heading is markdown the field carried, not text the form typed out.
  await form.getByRole('button', { name: 'Preview' }).click()
  await expect(form.getByTestId('markdown-preview').locator('h2')).toHaveText('Notes')

  // The mid-run upload (D18: scope `inputs`) — the field's value is the File
  // ref the files trio answered with, which is what its name coming back
  // proves; a raw `File` would never have one.
  await form.locator('input[type="file"]').setInputFiles(EXTRA_PNG)
  await expect(form.locator('.field-file-list')).toContainText('extra.png')

  await form.getByRole('button', { name: 'Approve' }).click()

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
  // ordinary Input | Output toggle, and its log card rides on Output.
  await drawStep.click()
  const pane = page.getByTestId('step-pane')
  await pane.getByRole('tab', { name: 'Output' }).click()
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

  // ---------------------------------------------------------------------
  // Phase 3: the four named renderers the workflow now declares. Each is
  // asserted by its wrapper rather than its innards — that a `render:` on a
  // declaration reaches the renderer it names is this smoke's business; what
  // each one draws is its own unit suite's (uPlot needs a canvas, and only
  // the real browser has one).
  // ---------------------------------------------------------------------

  // These are step-level outputs, which the page folds behind the "Every
  // step's outputs" disclosure (the pane already shows them a step at a time).
  await outputsAgain.getByTestId('run-step-outputs').locator('> summary').click()
  for (const render of ['transcript', 'chart', 'code', 'images']) {
    await expect(
      outputsAgain.locator(`[data-testid="renderer"][data-render="${render}"]`).first(),
      `no ${render} renderer in the run's outputs`,
    ).toBeVisible()
  }

  // Ruling P5: `review.outputs.cover` and the run-level `cover` are evaluated
  // synchronously and register nothing, so what a `file`-declared job output
  // carries in M2 is the tile's *path string* — a chip, not a file card. The
  // path is the poster's, which is the whole point of the pick.
  await expect(outputsAgain.locator('[data-output="cover"]')).toContainText('poster.svg')

  // ---------------------------------------------------------------------
  // 05 retention: the run's owner may delete it, behind the header's confirm.
  // ---------------------------------------------------------------------

  const del = page.getByTestId('run-delete')
  await expect(del).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await del.click()

  // The page after a deletion is the list, and the run is not on it.
  await expect(page).toHaveURL(/\/hello\/interactive\/runs$/)
  await expect(page.getByRole('link', { name: runId })).toHaveCount(0)
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
