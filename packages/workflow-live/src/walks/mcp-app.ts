/**
 * The MCP Apps host, emulated (apps#586; Phase 4 plan, Decision 8): what a
 * person's claude.ai session proved at the Phase-2/3 gates, headless — the
 * served step view mounts in a sandboxed frame under a host that answers
 * `ui/initialize` and proxies `tools/call` to the live endpoint; an island
 * is completed through it, then (Phase 4, story 10) a form; the run then
 * resumes on the harness page from the rows the widget wrote. Check names
 * cite D24 as amended (reports + one input in an agent host).
 */
import { writeFile } from 'node:fs/promises'
import { waitForSealedRecord } from '@bffless/workflow-headless'
import { chromium } from 'playwright'
import { appToken, credentials } from '../env.js'
import { openEmulatedHost } from '../host-emu.js'
import { STEP_VIEW_URI_PATTERN, cspOf, stepViewUriOf, type ListedTool } from '../mcp-checks.js'
import { openMcp } from '../mcp-client.js'
import { FORM_STEP, ISLAND_STEP, parkHelloRun } from '../park.js'
import { openSession, type Session } from '../session.js'
import { mintAppToken, type MintedToken } from '../token.js'
import type { Walk } from './index.js'

interface ToolAnswer { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }
const text = (r: ToolAnswer) => (r.content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n')

interface RunRecord { run?: { status?: string }; steps?: Array<Record<string, unknown>> }
const rowOf = (r: Record<string, unknown>) => (r.fields && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : r)

/**
 * The step's row off `GET /api/workflow/run?id=`, polled — not
 * `workflow.status`. On the private host, `workflow.status` (the endpoint's
 * in-process `data_query`) has been seen to lag the row by *minutes* (a
 * CE-side read-path bug, filed separately: a REST read of this same
 * endpoint showed the row `succeeded` with its outputs and annotations long
 * before `workflow.status` stopped saying `waiting`, on a brand-new session
 * with a bearer token and again with a cookie). The write itself is durable
 * the instant a bridge submit answers, so the record — read straight off
 * the row, the way `walks/mcp.ts`'s `record.stepSucceeded` does — is what a
 * check asserts against; `workflow.status`'s own view is still fetched and
 * carried in the evidence, unasserted, so a report shows the two agreeing
 * or not.
 */
async function recordStep(harness: string, token: string, runId: string, key: string, want: string, timeoutMs = 15_000): Promise<{ row: Record<string, unknown> | undefined; run: { status?: string } | undefined; waitedMs: number }> {
  const start = Date.now()
  for (;;) {
    const res = await fetch(`${harness}/api/workflow/run?id=${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${token}` } })
    const record = (await res.json().catch(() => null)) as RunRecord | null
    const row = (record?.steps ?? []).map(rowOf).find((r) => r.key === key)
    const waitedMs = Date.now() - start
    if (row?.status === want || waitedMs >= timeoutMs) return { row, run: record?.run, waitedMs }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

export const mcpApp: Walk = async ({ args, env, report }) => {
  const log: string[] = []
  const say = (line: string) => void log.push(line)
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing (needed to park runs and mint a token)')
  const minted: MintedToken[] = []
  let session: Awaited<ReturnType<typeof openMcp>> | null = null
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  // The one `openSession`-opened Chromium a park is in flight with, closed
  // unconditionally in the outer `finally` — `parkHelloRun` already closes it
  // on every path once it is called (own `finally`), but everything between
  // `openSession` and that call (`s.api.json`, `mintAppToken`) can throw
  // first, and only this outer-scope handle can catch that (`walks/mcp.ts`'s
  // `browser: Session | null` is the same guard).
  let s: Session | null = null
  try {
    // --- sign in, mint the token the host will carry, park a run on its island
    s = await openSession({ base: args.harness, out: args.out, credentials: creds })
    const project = await s.api.json('/api/workflow/project')
    const repository = String((project.body as { repository?: string } | null)?.repository ?? '')
    let token = appToken(env)
    if (!token) {
      const t = await mintAppToken(s.request, args.harness, repository, ['workflow:read', 'workflow:run', 'workflow:files'], `workflow-live mcp-app ${new Date().toISOString()}`)
      minted.push(t)
      token = t.token
    }
    if (args.parkOnly) {
      const p = await parkHelloRun(s, 'form', say)
      s = null // parkHelloRun closed it
      report.note(`parked run ${p.runId}, waiting on ${p.step} — hand it to the agent host`)
      console.log(`parked ${p.runId}`)
      return
    }
    const island = await parkHelloRun(s, 'island', say)
    s = null // parkHelloRun closed it
    report.run(island.runId)
    report.expect('D24.parkIsland', island.startedOk && island.waitingOk && island.rowStatus === 'waiting' && island.step === ISLAND_STEP, { runId: island.runId, rowStatus: island.rowStatus, rowWaitMs: island.rowWaitMs })

    // --- the endpoint: the revisioned URI, the resource
    session = await openMcp(args.harness, { token })
    const { client } = session
    const listed = (await client.listTools()).tools as ListedTool[]
    const uri = stepViewUriOf(listed)
    const read = await client.readResource({ uri })
    const resource = read.contents[0] as { mimeType?: string; text?: string } | undefined
    const html = resource?.text ?? ''
    report.expect('D24.stepViewUriIsRevisioned', STEP_VIEW_URI_PATTERN.test(uri) && resource?.mimeType === 'text/html;profile=mcp-app' && html.includes('form-step') && html.includes('data-testid="island"'), { uri, mimeType: resource?.mimeType, bytes: html.length, csp: cspOf(resource) })
    const call = async (params: { name: string; arguments?: Record<string, unknown> }) => {
      const answer = (await client.callTool({ name: params.name, arguments: params.arguments ?? {} })) as ToolAnswer
      say(`host → tools/call ${params.name} → ${answer.isError ? 'error' : 'ok'}: ${text(answer).slice(0, 100)}`)
      return answer
    }

    // --- the emulated host mounts the step view for the island; the island submits through the bridge
    await new Promise((resolve) => setTimeout(resolve, 61_000)) // the page's lease lapses (Phase 2 Decision 7)
    browser = await chromium.launch({ args: ['--no-sandbox'], handleSIGINT: false })
    const page = await browser.newPage({ viewport: { width: 720, height: 1000 } })
    page.on('console', (m) => { if (m.type() === 'error') say(`page console error: ${m.text()}`) })
    page.on('pageerror', (e) => say(`page error: ${e.message}`))
    const host = await openEmulatedHost(page, call)
    const view = await host.mount(html, { runId: island.runId, step: ISLAND_STEP, values: {} })
    await page.waitForFunction(() => window.__heights.length > 0, undefined, { timeout: 30_000 })
    // The app's own `ResizeObserver` (`step-view/main.tsx`) is decoupled from the
    // ext-apps handshake notifications — its first `size-changed` can land
    // between `ui/initialize` and `ui/notifications/initialized` (a paint race,
    // not a protocol violation) — so the check asks for order (`initialize`
    // before `initialized`, both present) and a reported size, not adjacency.
    const handshakeLog = await host.log()
    const initializeAt = handshakeLog.indexOf('ui/initialize')
    const initializedAt = handshakeLog.indexOf('ui/notifications/initialized')
    report.expect('D24.hostHandshake', initializeAt === 0 && initializedAt > initializeAt && (await host.heights())[0]! > 0, { log: handshakeLog.slice(0, 6), heights: await host.heights() })
    const islandFrame = view.locator('[data-testid="island"]').contentFrame()
    await islandFrame.getByTestId('line').first().waitFor({ timeout: 30_000 })
    await page.screenshot({ path: `${args.out}/02-island-in-host.png`, fullPage: true })
    report.expect('D24.islandMountsInHost', /is waiting for you/.test((await view.getByTestId('status').textContent()) ?? ''), { status: await view.getByTestId('status').textContent(), lines: await islandFrame.getByTestId('line').count() })
    await islandFrame.getByTestId('line').first().click()
    await islandFrame.getByTestId('submit').click()
    await view.getByTestId('submitted').waitFor({ state: 'visible', timeout: 30_000 })
    const { row: islandRow, waitedMs: islandWaitedMs } = await recordStep(args.harness, token, island.runId, ISLAND_STEP, 'succeeded')
    const islandStatusView = (await client.callTool({ name: 'workflow.status', arguments: { runId: island.runId } })) as ToolAnswer
    const islandOutputs = (islandRow?.outputs ?? {}) as { line?: unknown }
    report.expect('D24.islandSubmitsThroughBridge', islandRow?.status === 'succeeded' && islandOutputs.line === 'Hello, world!', {
      waitedMs: islandWaitedMs,
      row: islandRow && { status: islandRow.status, outputs: islandRow.outputs },
      statusView: (islandStatusView.structuredContent as { steps?: Record<string, string> } | undefined)?.steps?.[ISLAND_STEP],
    })
    await page.close()

    // --- a second run, parked on its form; the form renders and submits through the bridge
    s = await openSession({ base: args.harness, out: args.out, credentials: creds })
    const form = await parkHelloRun(s, 'form', say)
    s = null // parkHelloRun closed it
    report.run(form.runId)
    report.expect('D24.parkForm', form.startedOk && form.waitingOk && form.rowStatus === 'waiting' && form.step === FORM_STEP, { runId: form.runId, rowStatus: form.rowStatus, rowWaitMs: form.rowWaitMs })
    await new Promise((resolve) => setTimeout(resolve, 61_000))
    const page2 = await browser.newPage({ viewport: { width: 720, height: 1000 } })
    page2.on('console', (m) => { if (m.type() === 'error') say(`page2 console error: ${m.text()}`) })
    page2.on('pageerror', (e) => say(`page2 error: ${e.message}`))
    const host2 = await openEmulatedHost(page2, call)
    const view2 = await host2.mount(html, { runId: form.runId, step: FORM_STEP, values: {} })
    await view2.getByTestId('form-step').waitFor({ timeout: 30_000 })
    await page2.screenshot({ path: `${args.out}/03-form-in-host.png`, fullPage: true })
    // `cover` is a `choice` field over `card`'s posters (interactive.workflow.yaml)
    // — one option in this build (`D14.tilePicker` in walks/interactive.ts holds
    // the same count), so one tile, not two.
    const tiles = await view2.getByTestId('tile').count()
    report.expect('D24.formRendersInHost', tiles === 1 && (await view2.getByRole('button', { name: 'Approve' }).count()) === 1, { tiles, title: await view2.getByTestId('title').textContent() })
    report.expect('D24.formRefusesBlankRequired', await view2.getByTestId('form-step-submit').isDisabled(), { note: 'cover is required and blank' })
    try {
      await view2.getByTestId('tile').first().click()
      await view2.getByTestId('form-step-submit').waitFor({ state: 'attached' })
      say(`form-step-submit disabled before click: ${await view2.getByTestId('form-step-submit').isDisabled()}`)
      await view2.getByTestId('form-step-submit').click()
      await view2.getByTestId('submitted').waitFor({ state: 'visible', timeout: 45_000 })
      const { row: formRow, run: formRun, waitedMs: formWaitedMs } = await recordStep(args.harness, token, form.runId, FORM_STEP, 'succeeded')
      const formStatusView = (await client.callTool({ name: 'workflow.status', arguments: { runId: form.runId } })) as ToolAnswer
      const formOutputs = (formRow?.outputs ?? {}) as { cover?: { name?: unknown } }
      report.expect('D24.formSubmitsThroughBridge', formRow?.status === 'succeeded' && formRun?.status === 'running', {
        waitedMs: formWaitedMs,
        cover: formOutputs.cover?.name,
        run: formRun?.status,
        statusView: (formStatusView.structuredContent as { steps?: Record<string, string> } | undefined)?.steps?.[FORM_STEP],
      })
    } catch (e) {
      // Chromium never dispatches the `<form onSubmit>` at all here — the
      // click on the submit button is blocked pre-JS by the sandbox lacking
      // `allow-forms` ("Blocked form submission … the 'allow-forms'
      // permission is not set", captured by the page2 console listener
      // above into `log`). That is a property of *any* conforming sandboxed
      // host without `allow-forms`, not of this walk — `StepForm.tsx`'s
      // `<button type="submit">` inside `<form onSubmit>` needs it
      // regardless of which host mounts the view. Outside packages/workflow-
      // live (host-emu.ts's sandbox string, or the app); recorded as a
      // failure with evidence rather than let the walk die here so the
      // remaining checks still run.
      report.expect('D24.formSubmitsThroughBridge', false, { error: e instanceof Error ? e.message : String(e), note: 'native <form> submit blocked by the sandbox (no allow-forms) before StepForm.tsx\'s onSubmit ever runs — see page2 console error in mcp-app.log' })
    }
    await page2.close()

    // --- the harness page resumes the run the widget advanced: same rows, one history
    const s3 = await openSession({ base: args.harness, out: args.out, credentials: creds })
    try {
      await s3.page.goto(`${args.harness}/hello/interactive/runs/${form.runId}`)
      await s3.page.getByTestId('run-resume').click({ timeout: 60_000 })
      const sealed = await waitForSealedRecord(s3.api, form.runId, say, { timeoutMs: 120_000 })
      const status = String(((sealed.body as { run?: { status?: string } } | null)?.run ?? {}).status ?? '')
      report.expect('D24.runResumesOnHarness', status === 'succeeded', { status })
      await s3.shot('04-resumed-on-harness')
    } catch (e) {
      // If the form step above never succeeded (D24.formSubmitsThroughBridge),
      // the run is still waiting on it — Resume takes the harness page back
      // to driving it, not to a finished run — so this fails downstream of
      // that, honestly, rather than throwing the walk to BLOCKED.
      report.expect('D24.runResumesOnHarness', false, { error: e instanceof Error ? e.message : String(e) })
      await s3.shot('04-resumed-on-harness').catch(() => undefined)
    } finally {
      await s3.close()
    }
  } finally {
    await writeFile(`${args.out}/mcp-app.log`, log.join('\n'), 'utf8').catch(() => undefined)
    await session?.close()
    await browser?.close()
    await s?.close()
    for (const t of minted) await t.revoke()
  }
}
