import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

/**
 * Spec 10's page tools, end to end against the mock backend: `hello/interactive`
 * driven through `document.modelContext` alone — `workflow.start` → `await` →
 * `submitStep` (island, then form) → `outputs` — the way the live `page-tools`
 * walk (`packages/workflow-live`) drives it against a deployment. Nothing here
 * clicks; the page moves only because the tools move it (D21).
 *
 * The helpers are the built driver's (`@bffless/workflow-headless`'s
 * `callPageTool`), imported from `dist/` like `headless.spec.ts` imports its
 * CLI, and the spec fails loudly when the build is missing rather than
 * skipping. Playwright's `Page` satisfies the driver's `PageLike` structurally.
 */
const HEADLESS_DIST = fileURLToPath(new URL('../../../packages/workflow-headless/dist/index.js', import.meta.url))

test.beforeAll(() => {
  if (!existsSync(HEADLESS_DIST)) {
    throw new Error(
      `workflow-headless is not built: ${HEADLESS_DIST} is missing.\n` +
        'Run `pnpm --filter @bffless/workflow-headless build` before `pnpm --filter workflow test:e2e`.',
    )
  }
})

type Helpers = typeof import('../../../packages/workflow-headless/dist/index.js')

async function helpers(): Promise<Helpers> {
  return import(HEADLESS_DIST) as Promise<Helpers>
}

const isFileRef = (v: unknown): v is { path: string } =>
  typeof v === 'object' && v !== null && typeof (v as { path?: unknown }).path === 'string' && typeof (v as { url?: unknown }).url === 'string'

test('hello/interactive runs end to end through the page tools against the mock backend', async ({ page }) => {
  test.setTimeout(300_000)
  const { callPageTool, waitForPageTools } = await helpers()
  const call = (name: string, args: Record<string, unknown> = {}) => callPageTool(page as unknown as Parameters<typeof callPageTool>[0], name, args)
  const structured = (r: Awaited<ReturnType<typeof call>>) => (r.structuredContent ?? {}) as Record<string, unknown>

  await page.goto('/?mocks=on')
  await expect(page.getByTestId('implementations')).toContainText('hello')

  // Registration: the eleven catalog tools, the six read tools read-only (D19/D21).
  const tools = await waitForPageTools(page as unknown as Parameters<typeof waitForPageTools>[0], { timeoutMs: 30_000 })
  expect(tools.map((t) => t.name).sort()).toEqual(
    ['workflow.await', 'workflow.cancel', 'workflow.describe', 'workflow.list', 'workflow.outputs', 'workflow.resume', 'workflow.runs', 'workflow.sign', 'workflow.start', 'workflow.status', 'workflow.submitStep'],
  )
  expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort()).toEqual(
    ['workflow.await', 'workflow.describe', 'workflow.list', 'workflow.outputs', 'workflow.runs', 'workflow.status'],
  )

  // Spec 07's refusal, verbatim, and nothing started.
  const refused = await call('workflow.start', { impl: 'hello', workflow: 'interactive', inputs: { greeting: 42 } })
  expect(refused.isError).toBe(true)
  expect((structured(refused).errors as Record<string, string>).greeting).toBe('Expected a valid string value')
  expect((await call('workflow.status')).isError).toBe(true)

  // Start: the page navigates to the run the way the kickoff form does (D21).
  const started = await call('workflow.start', { impl: 'hello', workflow: 'interactive', inputs: {} })
  expect(started.isError).toBeFalsy()
  const runId = String(structured(started).runId)
  expect(runId).toMatch(/^run_/)
  await expect(page).toHaveURL(new RegExp(`/hello/interactive/runs/${runId}$`))
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-state', 'running')

  // The island step waits; the snapshot says what would satisfy it.
  const island = await call('workflow.await', { until: 'waiting', timeoutMs: 120_000 })
  expect(island.isError).toBeFalsy()
  const waitingOn = structured(island).waitingOn as Array<{ key: string; kind: string; inputs: Record<string, unknown>; src?: string }>
  expect(waitingOn[0]).toMatchObject({ key: 'pick/0/choose', kind: 'island' })
  expect(waitingOn[0]!.src).toMatch(/pick-line\.html/)
  const lines = waitingOn[0]!.inputs.lines as string[]
  expect(lines[0]).toBe('Hello, world!')

  const pickedIsland = await call('workflow.submitStep', { step: 'pick/0/choose', values: { line: lines[0], index: 0 } })
  expect(pickedIsland.isError, JSON.stringify(structured(pickedIsland).errors)).toBeFalsy()

  // The form step waits; its evaluated fields carry the File-ref options.
  const form = await call('workflow.await', { until: 'waiting', timeoutMs: 120_000 })
  const formWait = (structured(form).waitingOn as Array<{ key: string; kind: string; inputs: { fields: Record<string, { options?: unknown[] }> } }>)[0]!
  expect(formWait).toMatchObject({ key: 'review/0/confirm', kind: 'form' })
  const covers = formWait.inputs.fields.cover!.options!
  expect(isFileRef(covers[0])).toBe(true)

  const approved = await call('workflow.submitStep', {
    step: 'review/0/confirm',
    values: { cover: (covers[0] as { path: string }).path, notes: 'approved by page tools', extra: null },
  })
  expect(approved.isError, JSON.stringify(structured(approved).errors)).toBeFalsy()

  const finished = await call('workflow.await', { until: 'terminal', timeoutMs: 120_000 })
  expect(structured(finished).status).toBe('succeeded')
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')

  const outputs = await call('workflow.outputs')
  const poster = (structured(outputs).outputs as Record<string, unknown>).poster
  expect(isFileRef(poster)).toBe(true)

  const signed = await call('workflow.sign', { path: (poster as { path: string }).path })
  expect(signed.isError).toBeFalsy()
  expect(String(structured(signed).url)).toContain('signed=mock')

  const runs = await call('workflow.runs', { impl: 'hello', workflow: 'interactive' })
  expect((structured(runs).runs as Array<{ runId: string }>).map((r) => r.runId)).toContain(runId)

  // The record agrees with the page: a person-shaped run, both interactive steps succeeded.
  const record = await page.evaluate(async (id) => (await fetch(`/api/workflow/run?id=${id}`)).json(), runId)
  expect(record.run.status).toBe('succeeded')
  expect(record.run.headless).toBe(false)
  const byKey = Object.fromEntries((record.steps as Array<{ key: string; status: string; outputs?: Record<string, unknown> }>).map((s) => [s.key, s]))
  expect(byKey['pick/0/choose']).toMatchObject({ status: 'succeeded', outputs: { line: 'Hello, world!' } })
  expect(byKey['review/0/confirm']?.status).toBe('succeeded')
})

test('resume and cancel through the page tools', async ({ page }) => {
  test.setTimeout(300_000)
  const { callPageTool, waitForPageTools } = await helpers()
  const asPage = page as unknown as Parameters<typeof callPageTool>[0]
  const call = (name: string, args: Record<string, unknown> = {}) => callPageTool(asPage, name, args)
  const structured = (r: Awaited<ReturnType<typeof call>>) => (r.structuredContent ?? {}) as Record<string, unknown>

  // The mock backend seeds one `hello` run still in flight, parked on its
  // review form with its lease released (`mocks/fixtures/waitingRun.ts`) — a
  // run whose driver went away, which is exactly what `workflow.resume` is for.
  // (A reload would not do here: the mock db lives in the page, so reloading
  // forgets any run this test started.)
  const WAITING_RUN_ID = 'run_01hellowaiting000000000000'
  await page.goto('/?mocks=on')
  await waitForPageTools(asPage, { timeoutMs: 30_000 })

  const resumed = await call('workflow.resume', { runId: WAITING_RUN_ID })
  expect(resumed.isError, JSON.stringify(structured(resumed).errors)).toBeFalsy()
  await expect(page).toHaveURL(new RegExp(`/hello/hello/runs/${WAITING_RUN_ID}$`))
  const status = await call('workflow.status')
  expect(structured(status).runId).toBe(WAITING_RUN_ID)
  expect((structured(status).waitingOn as Array<{ key: string }>)[0]?.key).toBe('confirm/0/review')
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-state', 'running')

  const cancelled = await call('workflow.cancel')
  expect(cancelled.isError).toBeFalsy()
  expect(structured(cancelled).status).toBe('cancelled')
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-state', 'cancelled')

  const again = await call('workflow.cancel')
  expect(again.isError).toBe(true)
})
