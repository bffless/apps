/**
 * Page tools: the M5 Phase-1 gate (spec 10, D19–D21; apps#554 stories 2–4).
 * Signs in, opens the harness, and drives a full `hello/interactive` run
 * **through the page's WebMCP tools alone** — `workflow.start` → `await` →
 * `submitStep` (island, then form) → `outputs` → `sign` — asserting on the
 * page's answers and then on the run record it left behind. A second run
 * proves `resume` (after a reload drops the tab's driver) and `cancel`.
 *
 * Nothing here clicks. The page is navigated only by the tools themselves
 * (`D21.startNavigates`) and by one deliberate reload before `resume`.
 * Check names cite the decision they prove; keep them stable once shipped.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  callPageTool,
  resultText,
  waitForPageTools,
  waitForSealedRecord,
  type PageToolResult,
} from '@bffless/workflow-headless'
import { credentials } from '../env.js'
import { isFileRef, parseRecord, stepByKey } from '../record.js'
import { openSession, redactUrl } from '../session.js'
import type { Walk } from './index.js'

const READ_TOOLS = ['workflow.list', 'workflow.describe', 'workflow.status', 'workflow.await', 'workflow.runs', 'workflow.outputs']
const ALL_TOOLS = [...READ_TOOLS, 'workflow.start', 'workflow.submitStep', 'workflow.sign', 'workflow.cancel', 'workflow.resume']

const structured = (result: PageToolResult) => (result.structuredContent ?? {}) as Record<string, unknown>
const errorsOf = (result: PageToolResult) => (structured(result).errors ?? {}) as Record<string, string>
const brief = (result: PageToolResult) => ({ isError: result.isError ?? false, text: resultText(result).slice(0, 300) })

interface Waiting { key: string; kind: string; inputs: Record<string, unknown>; src?: string }
const waitingOf = (result: PageToolResult) => (structured(result).waitingOn ?? []) as Waiting[]

export const pageTools: Walk = async ({ args, env, report }) => {
  const creds = credentials(env)
  if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing')
  const s = await openSession({ base: args.harness, out: args.out, credentials: creds })
  try {
    const { page } = s
    const call = (name: string, toolArgs: Record<string, unknown> = {}) => callPageTool(page, name, toolArgs)

    // --- Registration (D19/D21): only the catalog, read tools marked read-only
    const tools = await waitForPageTools(page, { timeoutMs: 30_000 })
    const names = tools.map((tool) => tool.name).sort()
    report.expect('D21.onlyWorkflowTools', names.length === ALL_TOOLS.length && names.every((name) => ALL_TOOLS.includes(name)), names)
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name).sort()
    report.expect('D19.readOnlyHints', readOnly.join(',') === [...READ_TOOLS].sort().join(','), readOnly)

    // --- Discovery through the tools
    const list = await call('workflow.list')
    const impls = (structured(list).implementations ?? []) as Array<{ alias: string; workflows: Array<{ id: string; headlessSafe: unknown }> }>
    const hello = impls.find((impl) => impl.alias === 'hello')
    const interactive = hello?.workflows.find((workflow) => workflow.id === 'interactive')
    report.expect('D19.listsHello', !list.isError && !!interactive && typeof interactive.headlessSafe === 'boolean', { ...brief(list), aliases: impls.map((impl) => impl.alias) })

    const describe = await call('workflow.describe', { impl: 'hello', workflow: 'interactive' })
    const described = structured(describe) as { inputs?: Record<string, { required?: boolean }>; jobs?: Array<{ id: string; steps: Array<{ id: string; kind: string; headless?: string }> }> }
    const choose = described.jobs?.find((job) => job.id === 'pick')?.steps.find((step) => step.id === 'choose')
    const confirm = described.jobs?.find((job) => job.id === 'review')?.steps.find((step) => step.id === 'confirm')
    report.expect(
      'D20.describeInteractive',
      !describe.isError && described.inputs?.greeting?.required === true && choose?.kind === 'island' && choose.headless === 'auto' && confirm?.kind === 'form' && confirm.headless === 'skip',
      { ...brief(describe), choose, confirm },
    )

    // --- Spec 07's refusal vocabulary, verbatim, and nothing started
    const refused = await call('workflow.start', { impl: 'hello', workflow: 'interactive', inputs: { greeting: 42, names: ['world'] } })
    const afterRefusal = await call('workflow.status')
    report.expect(
      'spec07.refusalVerbatim',
      refused.isError === true && errorsOf(refused).greeting === 'Expected a valid string value' && afterRefusal.isError === true,
      { ...brief(refused), errors: errorsOf(refused), statusAfter: brief(afterRefusal) },
    )

    // --- The run, driven end to end through the tools
    const started = await call('workflow.start', { impl: 'hello', workflow: 'interactive', inputs: { greeting: 'Hello', names: ['world', 'studio'] } })
    const runId = String(structured(started).runId ?? '')
    if (runId) report.run(runId)
    await page.waitForURL((url) => url.pathname.endsWith(`/hello/interactive/runs/${runId}`), { timeout: 10_000 }).catch(() => undefined)
    report.expect('D21.startNavigates', !started.isError && runId.startsWith('run_') && page.url().includes(`/hello/interactive/runs/${runId}`), { ...brief(started), url: page.url() })
    await s.shot('01-started')

    const island = await call('workflow.await', { until: 'waiting', timeoutMs: 120_000 })
    const islandWait = waitingOf(island)[0]
    const lines = (islandWait?.inputs.lines ?? []) as unknown[]
    report.expect(
      'spec10.awaitWaitingIsland',
      !island.isError && islandWait?.key === 'pick/0/choose' && islandWait.kind === 'island' && /pick-line\.html/.test(islandWait.src ?? '') && lines.length > 0,
      { ...brief(island), waitingOn: waitingOf(island).map((w) => ({ key: w.key, kind: w.kind, src: w.src })), lines },
    )
    await s.shot('02-island-waiting')

    const pickedLine = lines[0]
    const submittedIsland = await call('workflow.submitStep', { step: 'pick/0/choose', values: { line: pickedLine, index: 0 } })
    const islandSteps = ((structured(submittedIsland).snapshot ?? {}) as { steps?: Record<string, string> }).steps ?? {}
    report.expect('D21.submitIslandStep', !submittedIsland.isError && islandSteps['pick/0/choose'] === 'succeeded', { ...brief(submittedIsland), errors: errorsOf(submittedIsland), status: islandSteps['pick/0/choose'] })

    const form = await call('workflow.await', { until: 'waiting', timeoutMs: 120_000 })
    const formWait = waitingOf(form)[0]
    const fields = ((formWait?.inputs.fields ?? {}) as Record<string, { options?: unknown }>)
    const covers = Array.isArray(fields.cover?.options) ? (fields.cover.options as unknown[]) : []
    report.expect('spec10.awaitWaitingForm', !form.isError && formWait?.key === 'review/0/confirm' && formWait.kind === 'form' && covers.length > 0 && isFileRef(covers[0]), { ...brief(form), key: formWait?.key, covers: covers.length })
    await s.shot('03-form-waiting')

    const cover = isFileRef(covers[0]) ? covers[0].path : ''
    const submittedForm = await call('workflow.submitStep', { step: 'review/0/confirm', values: { cover, notes: 'approved by page tools', extra: null } })
    report.expect('D21.submitFormStep', !submittedForm.isError, { ...brief(submittedForm), errors: errorsOf(submittedForm) })

    const finished = await call('workflow.await', { until: 'terminal', timeoutMs: 120_000 })
    const outputs = await call('workflow.outputs')
    const poster = (structured(outputs).outputs as Record<string, unknown> | undefined)?.poster
    report.expect('run.succeeded', !finished.isError && structured(finished).status === 'succeeded' && isFileRef(poster), { ...brief(finished), poster: isFileRef(poster) ? poster.path : poster })
    await s.shot('04-succeeded')

    const signed = await call('workflow.sign', { path: isFileRef(poster) ? poster.path : '' })
    const url = String(structured(signed).url ?? '')
    const presigned = /^https?:\/\//.test(url) && !url.startsWith(args.harness) && /X-Goog-Signature=|X-Amz-Signature=|[?&]sig(nature)?=/.test(url)
    report.expect('D6.signIsPresigned', !signed.isError && presigned && Number(structured(signed).expiresIn) > 0, { ...brief(signed), url: redactUrl(url), expiresIn: structured(signed).expiresIn })

    const runs = await call('workflow.runs', { impl: 'hello', workflow: 'interactive', limit: 5 })
    const listed = ((structured(runs).runs ?? []) as Array<{ runId: string }>).map((run) => run.runId)
    report.expect('spec10.runsListsIt', !runs.isError && listed.includes(runId), { ...brief(runs), listed })

    // --- The record agrees with the page
    const sealed = await waitForSealedRecord(s.api, runId, (line) => report.note(line))
    await writeFile(join(args.out, 'run.json'), JSON.stringify(sealed.body, null, 2), 'utf8')
    const rec = parseRecord(sealed.body)
    const pick = stepByKey(rec, 'pick/0/choose')
    const review = stepByKey(rec, 'review/0/confirm')
    report.expect(
      'record.matchesPage',
      rec.run?.status === 'succeeded' && rec.run.headless === false && pick?.status === 'succeeded' && pick.outputs?.line === pickedLine && review?.status === 'succeeded' && isFileRef(review.outputs?.cover) && isFileRef(rec.run.outputs?.poster),
      { status: rec.run?.status, headless: rec.run?.headless, pick: { status: pick?.status, line: pick?.outputs?.line }, review: { status: review?.status, cover: isFileRef(review?.outputs?.cover) } },
    )

    // --- Resume + cancel on a second run: a reload drops this tab's driver;
    // the lease is still ours (the owner id lives in sessionStorage), and
    // `workflow.resume` takes it back over and drives from here.
    const second = await call('workflow.start', { impl: 'hello', workflow: 'interactive', inputs: { greeting: 'Again', names: ['world'] } })
    const secondId = String(structured(second).runId ?? '')
    if (secondId) report.run(secondId)
    const secondWaiting = await call('workflow.await', { until: 'waiting', timeoutMs: 120_000 })
    const runUrl = `${args.harness}/hello/interactive/runs/${secondId}`
    await page.goto(runUrl, { waitUntil: 'networkidle' })
    await waitForPageTools(page, { timeoutMs: 30_000 })
    const resumed = await call('workflow.resume', { runId: secondId })
    const statusAfterResume = await call('workflow.status')
    report.expect(
      'D21.resumeAdopts',
      !second.isError && !secondWaiting.isError && !resumed.isError && structured(statusAfterResume).runId === secondId && page.url().includes(`/runs/${secondId}`),
      { start: brief(second), resume: brief(resumed), errors: errorsOf(resumed), statusRunId: structured(statusAfterResume).runId, url: page.url() },
    )
    await s.shot('05-resumed')
    const cancelled = await call('workflow.cancel')
    const cancelledRecord = await waitForSealedRecord(s.api, secondId, (line) => report.note(line))
    const cancelledStatus = parseRecord(cancelledRecord.body).run?.status
    report.expect('D21.cancelIsCancelled', !cancelled.isError && structured(cancelled).status === 'cancelled' && cancelledStatus === 'cancelled', { ...brief(cancelled), record: cancelledStatus })

    report.expect('page.noConsoleErrors', s.consoleErrors.length === 0, s.consoleErrors)
  } catch (e) {
    await s.shot('99-failed')
    throw e
  } finally {
    await writeFile(`${args.out}/network.log`, s.log.join('\n'), 'utf8').catch(() => undefined)
    await s.close()
  }
}
