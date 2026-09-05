/**
 * Driven runs (ADR-0006; apps#598): a run started over the MCP endpoint is
 * driven by the implementation's own dispatched headless job, not by the
 * caller. `workflow.start` mints the run id, asks the harness's `run/drive`
 * rule to `repository_dispatch` the implementation's `workflow-drive.yml` and
 * answers `pending` before any row exists; the job writes the rows, parks the
 * run on `hello/driven`'s undeclared form and exits, leaving no lease behind;
 * `workflow.submitStep` writes the answer and re-dispatches, and the second
 * job drives the run to the end. Six checks, two Actions jobs in the
 * implementation repo, one hello run.
 *
 * Both halves of the driven path are cross-repo (Tasks 13 and 16): until
 * `bffless/workflow-implementations` publishes `hello/driven` and a
 * `driver.repo`, `workflow.start` refuses — with `errors.workflow` for the
 * unknown workflow, with `errors.tool` naming `NO_DRIVER` for the missing
 * driver. Either is a `block`, never a fail: the walk is written now so it is
 * ready the day those land, and until then it says which piece is missing.
 *
 * The token is minted the way `walks/mcp.ts` mints it — sign in through the
 * relay, mint through that browser context, revoke at the end — because the
 * endpoint runs as the caller (D23 rung 2) and `driven.startedByTheToken`
 * asserts exactly that: the record's `startedBy` is the member the token
 * belongs to. `WORKFLOW_APP_TOKEN` skips the mint; the browser session stays
 * open either way, for `whoami` and for the run record.
 */
import { appToken, credentials } from '../env.js'
import { openMcp, type McpSession } from '../mcp-client.js'
import { openSession, type Session } from '../session.js'
import { mintAppToken, type MintedToken } from '../token.js'
import type { Walk } from './index.js'

const IMPL = 'hello'
const WORKFLOW = 'driven'
const STEP = 'ask/0/answer'
const NOTE = 'from the endpoint'
/** An Actions cold start is ~1–2 minutes; two of them plus the run itself fit well inside this. */
const POLL_TIMEOUT_MS = 8 * 60_000
const POLL_EVERY_MS = 10_000

interface ToolAnswer {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}

/** `workflow.status`'s snapshot (`apps/workflow/src/mcp/reply.ts`), every field optional so a refusal reads as an empty one. */
interface Snapshot {
  runId?: string
  status?: string
  pending?: boolean
  currentSteps?: string[]
  outputs?: Record<string, unknown>
  waitingOn?: Array<{ key?: string; kind?: string }>
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<ToolAnswer>

const text = (r: ToolAnswer) => (r.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
const structured = (r: ToolAnswer) => r.structuredContent ?? {}
const errorsOf = (r: ToolAnswer) => (structured(r).errors ?? {}) as Record<string, string>
const brief = (r: ToolAnswer) => ({ isError: r.isError ?? false, text: text(r).slice(0, 300) })
const snapshotOf = (r: ToolAnswer) => structured(r) as Snapshot

/**
 * Poll `workflow.status` every 10 s until `until` holds, and hand back that
 * snapshot; `null` when `timeoutMs` passes first (the caller's check then
 * fails with the last snapshot as evidence). A refused status is a snapshot
 * that satisfies nothing, so a transient error just costs one interval.
 */
export async function pollStatus(call: Call, runId: string, until: (s: Snapshot) => boolean, timeoutMs: number): Promise<Snapshot | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answer = await call('workflow.status', { runId })
    const snapshot = snapshotOf(answer)
    if (!answer.isError && until(snapshot)) return snapshot
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS))
  }
}

export const driven: Walk = async ({ args, env, report }) => {
  let mcp: McpSession | null = null
  let browser: Session | null = null
  const minted: MintedToken[] = []
  try {
    const creds = credentials(env)
    if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing (needed to mint an app token and to read whoami + the run record)')
    browser = await openSession({ base: args.harness, out: args.out, credentials: creds })
    const who = await browser.api.json('/api/workflow/whoami')
    const memberId = String((who.body as { id?: string } | null)?.id ?? '')
    if (memberId === '') return report.block('GET /api/workflow/whoami answered no id — cannot tell who the token belongs to')
    let token = appToken(env)
    if (!token) {
      const project = await browser.api.json('/api/workflow/project')
      const repository = String((project.body as { repository?: string } | null)?.repository ?? '')
      if (repository === '') return report.block('GET /api/workflow/project answered no repository — cannot bind a token')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const all = await mintAppToken(browser.request, args.harness, repository, ['workflow:read', 'workflow:run', 'workflow:files'], `workflow-live driven ${stamp}`)
      minted.push(all)
      token = all.token
    }

    try {
      mcp = await openMcp(args.harness, { token })
    } catch (e) {
      return report.block(`initialize failed against ${args.harness}/api/workflow/mcp: ${e instanceof Error ? e.message : String(e)}`)
    }
    const client = mcp.client
    const call: Call = async (name, toolArgs = {}) => (await client.callTool({ name, arguments: toolArgs })) as ToolAnswer

    // --- the endpoint dispatches the implementation's driver and answers `pending` (ADR-0006)
    const start = await call('workflow.start', { impl: IMPL, workflow: WORKFLOW, inputs: { greeting: 'Hello' } })
    if (start.isError && /NO_DRIVER/.test(text(start))) return report.block(`${IMPL} publishes no driver on this harness (index.json driver.repo) — the cross-repo half is Task 16: ${text(start).slice(0, 200)}`)
    if (start.isError && 'workflow' in errorsOf(start)) return report.block(`${IMPL} publishes no ${WORKFLOW} workflow on this harness — the cross-repo half is Task 13: ${text(start).slice(0, 200)}`)
    const runId = String(structured(start).runId ?? '')
    report.expect('driven.startPending', !start.isError && structured(start).pending === true && structured(start).status === 'pending' && runId !== '', { ...brief(start), runId })
    if (runId === '') return report.block('workflow.start answered no runId — nothing to poll')
    report.run(runId)

    // --- the dispatched job writes the rows and parks the run on the undeclared form
    const parked = await pollStatus(call, runId, (s) => s.status === 'running' && (s.waitingOn ?? []).some((w) => w.key === STEP), POLL_TIMEOUT_MS)
    report.expect('driven.parksOnTheForm', parked !== null && (parked.currentSteps ?? []).join(',') === STEP && (parked.waitingOn ?? [])[0]?.kind === 'form', {
      waitedMs: parked === null ? POLL_TIMEOUT_MS : undefined,
      snapshot: parked,
    })
    // A run that never parks is a red driven path, not a missing precondition: keep the FAIL and stop rather than spend another eight minutes proving it twice.
    if (parked === null) {
      report.note(`run ${runId} never parked on ${STEP} within ${POLL_TIMEOUT_MS / 60_000} minutes — the four checks after it were not reached`)
      return
    }

    // --- the driver exited rather than holding the run open: the row carries no lease
    const record = await browser.api.json(`/api/workflow/run?id=${encodeURIComponent(runId)}`)
    const run = (record.body as { run?: Record<string, unknown> } | null)?.run ?? {}
    const fields = (run.fields && typeof run.fields === 'object' ? (run.fields as Record<string, unknown>) : run)
    report.expect('driven.leaseCleared', record.status === 200 && fields.leaseOwner == null, { status: record.status, leaseOwner: fields.leaseOwner ?? null, runStatus: fields.status })

    // --- the answer is written over the endpoint, and a second driver is dispatched to carry it on
    const answered = await call('workflow.submitStep', { runId, step: STEP, values: { note: NOTE } })
    report.expect('driven.submitDispatches', !answered.isError && /a driver was dispatched to continue the run/.test(text(answered)) && structured(answered).dispatched === true, {
      ...brief(answered),
      dispatched: structured(answered).dispatched,
    })

    // --- the second job finishes the run, carrying the answer into the outputs
    const done = await pollStatus(call, runId, (s) => s.status !== 'running' && s.status !== 'pending', POLL_TIMEOUT_MS)
    const output = String((done?.outputs as { text?: unknown } | undefined)?.text ?? '')
    report.expect('driven.completes', done?.status === 'succeeded' && output.includes(NOTE), { snapshot: done, text: output.slice(0, 200) })

    // --- the endpoint ran as the caller: the run belongs to the member the token was minted for (D23)
    report.expect('driven.startedByTheToken', fields.startedBy === memberId, { startedBy: fields.startedBy ?? null, memberId })
  } finally {
    await mcp?.close()
    for (const t of minted) await t.revoke()
    await browser?.close()
  }
}
