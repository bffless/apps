/**
 * Ownership (spec 11 — D26, D27, D29; ADR-0007): a second member cannot see,
 * sign or touch member A's run. The spec's own Testing section says why this
 * walk exists and why it cannot run unattended: *"A second identity …
 * requires a second member on the live harness — a prerequisite the walk
 * cannot create for itself."* `WORKFLOW_EMAIL_2`/`WORKFLOW_PASSWORD_2` (or
 * `WORKFLOW_APP_TOKEN_2`) is that prerequisite, person-created; its absence
 * is a `block`, never a FAIL — everything below is inert without a real
 * second account to be member B.
 *
 * Member A (the walk's usual login) starts a `hello/driven` run **on the
 * page**, reusing `hello.ts`'s session/navigation mechanics — implementations
 * → hello → the `Driven hello` workflow → kickoff. `driven`'s `ask/0/answer`
 * step is the "undeclared form" `walks/driven.ts` already documents: it
 * carries no schema, so there is nothing for the page to render — finishing
 * the run therefore switches to the same mechanics `driven`/`mcp` use, an app
 * token minted through A's own browser context and `workflow.submitStep`
 * over the MCP endpoint. Finishing is best-effort (`ownership.aRunFinished`):
 * every check below reads a run record or signs a run path, neither of which
 * needs the run to have reached a terminal status, so a slow or stuck finish
 * does not block the ownership checks that are this walk's actual point.
 *
 * Member B is a second, fully independent `openSession` — a second Chromium
 * launch, not a second tab or context on A's browser, so there is no cookie
 * jar to accidentally share (`session.ts`'s `openSession` launches its own
 * `Browser` every call).
 *
 * D26 (the model): `GET /api/workflow/runs` defaults to the caller's own
 * runs; `GET /api/workflow/run?id=` answers a run B cannot reach with 200
 * `{ run: null }`, indistinguishable from an unknown id; `POST
 * /api/workflow/run/update` answers 404 (a real 404, not the get's null —
 * the spec's own "404, not 403" is about not leaking existence through a
 * write, which a 200/null cannot do without also hiding every legitimate
 * "record not found"). D27 (the exemption is asked for): `?scope=all`
 * without the project owner/admin role is a 403; a caller who holds the role
 * gets everyone's runs, asked for on both sides (B reading A's, and — if A
 * holds the role — A reading B's), and the same refusal over the MCP endpoint
 * (`workflow.outputs` — never `workflow.status`, whose `pendingOr` window
 * answers a 200 `pending` snapshot for a freshly minted id). D29 (files follow the run): a run path
 * under `runs/<id>/` is gated exactly like the record; the workflow-wide
 * `inputs/` area is not run-scoped (D18) and stays member-wide, so B can
 * sign into it.
 */
import { appToken, credentials, secondAppToken, secondCredentials } from '../env.js'
import { openMcp } from '../mcp-client.js'
import { openSession, sessionLogin, type Session } from '../session.js'
import { pollStatus } from './driven.js'
import { adminOriginOf, mintAppToken, WALK_SCOPES, type MintedToken } from '../token.js'
import type { Walk } from './index.js'

const IMPL = 'hello'
const WORKFLOW = 'driven'
const WORKFLOW_LINK = 'Driven hello'
const STEP = 'ask/0/answer'
const NOTE = 'from the ownership walk'
const ALL_SCOPE_ROLES = new Set(['owner', 'admin'])
const POLL_TIMEOUT_MS = 8 * 60_000
/** Bounds for `submitStepPastLease` — the same 90s/5s the `mcp` walk's `spec10.leaseLapses` uses. */
const LEASE_RETRY_TIMEOUT_MS = 90_000
const LEASE_RETRY_INTERVAL_MS = 5_000
/** Bound for `waitForRowWaiting` — the page auto-progresses several jobs (spec 07) before parking on the undeclared form. */
const PARK_TIMEOUT_MS = 120_000

interface Who { id?: string; email?: string; role?: string; projectRole?: string }
interface ToolAnswer { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }
type Call = (name: string, toolArgs?: Record<string, unknown>) => Promise<ToolAnswer>

const text = (r: ToolAnswer) => (r.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
const structured = (r: ToolAnswer) => r.structuredContent ?? {}
const errorsOf = (r: ToolAnswer) => (structured(r).errors ?? {}) as Record<string, string>
const brief = (r: ToolAnswer) => ({ isError: r.isError ?? false, text: text(r).slice(0, 300) })
const isLeaseRefusal = (r: ToolAnswer) => 'lease' in errorsOf(r)

/**
 * Retry `workflow.submitStep` until the refusal stops being the live lease —
 * `mcp.ts`'s `spec10.leaseLapses`, restated for `submitStep`. A's own page
 * drove this run to `waiting`, so closing that page stops its heartbeat but
 * does not clear the lease immediately: the lease has its own TTL, and the
 * first submit(s) can still answer `errors.lease` for up to ~60s. Stops the
 * moment the refusal is anything else, so a real validation failure surfaces
 * immediately rather than being masked by the retry; pure apart from `call`
 * and the clock, so it is testable with a fake `call`.
 */
export async function submitStepPastLease(
  call: Call,
  runId: string,
  step: string,
  values: Record<string, unknown>,
  timeoutMs = LEASE_RETRY_TIMEOUT_MS,
  everyMs = LEASE_RETRY_INTERVAL_MS,
): Promise<ToolAnswer> {
  const deadline = Date.now() + timeoutMs
  let answer: ToolAnswer
  for (;;) {
    answer = await call('workflow.submitStep', { runId, step, values })
    if (!isLeaseRefusal(answer)) return answer
    if (Date.now() >= deadline) return answer
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

const MINT_STATUS_RE = /answered (\d+)\b/

/**
 * True when `mintFor` failed because B is signed in but holds no membership
 * on the harness project — `POST admin.<domain>/api/app-tokens` answers 403
 * "You are not a member of this project" (`token.ts`'s `mintAppToken` folds
 * status + body into the thrown message). That is a missing precondition —
 * B needs adding to the project, not a bug under test — so the caller turns
 * it into a `report.note` and skips the check rather than a FAIL. Any other
 * mint failure (network, 401, a malformed answer) returns `false` and stays
 * a FAIL via the normal `report.guard` path.
 */
export function isNotAProjectMember(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return MINT_STATUS_RE.exec(message)?.[1] === '403' && /not a member of this project/i.test(message)
}

/** A record's columns: flattened onto the row, or nested under `fields` — every rule in this set tolerates both. */
const fieldsOf = (row: Record<string, unknown>): Record<string, unknown> => {
  const f = row.fields
  return f && typeof f === 'object' && Object.keys(f as object).length > 0 ? (f as Record<string, unknown>) : row
}
/** `runs/get` answers a bare array (`shape.fn.js`); a JSON parse failure or an error body is `[]`, not a throw. */
const rowsOf = (body: unknown): Record<string, unknown>[] => (Array.isArray(body) ? (body as Record<string, unknown>[]) : [])
const runIdsOf = (body: unknown): unknown[] => rowsOf(body).map((r) => fieldsOf(r).runId)

export interface RowWait { waiting: boolean; lastStatus: string; snapshot: Record<string, unknown> | null }

/**
 * Poll a run's server-side row for `step`, not the page's own client-side
 * mirror (`window.__workflow.steps`) — that mirror can flip to "waiting"
 * optimistically before the write that backs it has actually landed, and the
 * caller closes the driving tab right after this resolves, which can abort
 * that write in flight and leave the row stuck `queued` forever (the bug
 * this replaced). Bounded, generalizing `park.ts`'s own row-poll to `driven`
 * runs, whose page auto-progresses several jobs (spec 07) before parking on
 * the undeclared form. Pure apart from `getRun` and the clock, so it is
 * testable with a fake `getRun`.
 */
export async function waitForRowWaiting(getRun: () => Promise<{ steps?: Array<Record<string, unknown>> } | null>, step: string, timeoutMs: number, everyMs = 1_000): Promise<RowWait> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = await getRun()
    const row = (record?.steps ?? []).map(fieldsOf).find((r) => r.key === step) ?? null
    const lastStatus = String(row?.status ?? '')
    if (lastStatus === 'waiting') return { waiting: true, lastStatus, snapshot: row }
    if (Date.now() >= deadline) return { waiting: false, lastStatus, snapshot: row }
    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }
}

async function whoAmI(s: Session): Promise<Who> {
  const res = await s.api.json('/api/workflow/whoami')
  return (res.body as Who | null) ?? {}
}

/**
 * Mint an app token through a signed-in browser context — `token.ts`'s
 * mechanics, as `driven`/`mcp` use them. Hands back the `MintedToken` rather
 * than auto-registering it for revocation: B's token is fine revoked through
 * the session it was minted with (`b` stays open to the end), but A's own
 * `aRunFinished` guard closes `a`'s session right after minting, which would
 * leave `MintedToken.revoke`'s captured request client dead — the caller
 * decides how (and through which live session) that one gets revoked.
 */
async function mintFor(s: Session, harness: string, label: string): Promise<MintedToken> {
  const project = await s.api.json('/api/workflow/project')
  const repository = String((project.body as { repository?: string } | null)?.repository ?? '')
  if (repository === '') throw new Error(`GET /api/workflow/project answered no repository — cannot bind a token (${label})`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return mintAppToken(s.request, harness, repository, [...WALK_SCOPES], `workflow-live ownership ${label} ${stamp}`)
}

/**
 * Revoke a token by id through `s`'s own request client — not through
 * `MintedToken.revoke()`'s own closure, which replays the client the token
 * was minted through. `aRunFinished` mints A's token through the session it
 * is about to close, so it revokes by id here instead, through whichever
 * session is live at the walk's own final cleanup (the reopened one, on the
 * happy path) — a no-op, not a throw, when `s` is undefined or its session
 * has gone away (mirrors `MintedToken.revoke`'s own `.catch(() => undefined)`).
 */
async function revokeToken(s: Session | undefined, harness: string, id: string): Promise<void> {
  if (!s) return
  await s.request.delete(`${adminOriginOf(harness)}/api/app-tokens/${id}`).catch(() => undefined)
}

/**
 * Run `body`, then always run `reopen` afterward — success or throw — before
 * `body`'s own outcome (return or rethrow) is handed back. Generalizes the
 * `a = await openSession(...)` reopen `ownership.aRunFinished` needs after
 * closing A's driving tab: whatever the close-and-submit-over-MCP sequence
 * does, A gets a fresh session back for the D29/D27 reads that read as A
 * later in the walk. Pure apart from `body`/`reopen` themselves, so the
 * "reopen always happens, even on a throw" contract is unit-testable without
 * a browser.
 */
export async function withReopenedSession<T>(body: () => Promise<T>, reopen: () => Promise<void>): Promise<T> {
  try {
    return await body()
  } finally {
    await reopen()
  }
}

/**
 * Start a `hello/driven` run through the page — `hello.ts`'s own navigation,
 * pointed at the `Driven hello` workflow instead of `Interactive hello`. No
 * island/form to complete here: the kickoff itself is the whole DOM
 * interaction this walk needs from either member.
 */
async function startDrivenRunOnPage(s: Session, shotTag: string): Promise<string> {
  const { page } = s
  await page.getByTestId('implementations').waitFor({ timeout: 30_000 })
  await page.getByTestId('implementations').getByRole('link', { name: /^hello$/i }).click()
  await page.getByTestId('workflow-list').getByRole('link', { name: WORKFLOW_LINK }).click()
  await page.getByTestId('job').first().waitFor()
  await page.getByRole('link', { name: /start a run/i }).click()
  await page.getByTestId('kickoff-form').waitFor()
  await page.getByTestId('kickoff-start').click()
  await page.getByTestId('run-status').waitFor()
  const runUrl = page.url().replace(/\?.*$/, '')
  const runId = runUrl.split('/').pop() ?? ''
  await s.shot(shotTag)
  return runId
}

export const ownership: Walk = async ({ args, env, report }) => {
  // The one precondition this walk cannot create for itself (spec 11 §Testing).
  const bLogin = sessionLogin(secondAppToken(env), secondCredentials(env))
  if (!bLogin) return report.block('second member not configured: set WORKFLOW_EMAIL_2/WORKFLOW_PASSWORD_2 or WORKFLOW_APP_TOKEN_2')
  const aLogin = sessionLogin(appToken(env), credentials(env))
  if (!aLogin) return report.block("WORKFLOW_APP_TOKEN (minted with auth:session) or WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing (member A — the walk's usual login)")

  let a: Session | undefined
  let b: Session | undefined
  let aMintedId: string | undefined
  const minted: MintedToken[] = []

  try {
    // =====================================================================
    // Member A: a hello/driven run, started on the page, finished over MCP
    // =====================================================================
    a = await openSession({ base: args.harness, out: args.out, ...aLogin })
    let runIdA = ''
    const startedA = await report.guard(['ownership.aRunStarted'], async () => {
      runIdA = await startDrivenRunOnPage(a!, '01-a-started')
      report.expect('ownership.aRunStarted', runIdA !== '', { runId: runIdA })
    })
    if (!startedA || runIdA === '') {
      report.note(`could not start a ${IMPL}/${WORKFLOW} run as member A — the ownership checks below need a real run to test against`)
      return
    }
    report.run(runIdA)
    const who = await whoAmI(a)

    // Best-effort: finish the run so it is a complete citizen of the harness. Not
    // required by any check below — a run record and its file paths exist, and
    // are ownership-gated, the moment the run row is created.
    await report.guard(['ownership.aRunFinished'], async () => {
      // A's page IS this run's driver (spec 07 §Driven runs): it auto-drives
      // the earlier jobs and parks at `ask/0/answer`, the undeclared form.
      // Wait for the *server* row to say `waiting`, not the page's own
      // client-side mirror — closing the tab a moment after the mirror flips
      // can abort the write that persists it, leaving the row `queued`
      // forever with nothing left to drive it there.
      const parked = await waitForRowWaiting(async () => {
        const res = await a!.api.json(`/api/workflow/run?id=${encodeURIComponent(runIdA)}`)
        return res.body as { steps?: Array<Record<string, unknown>> } | null
      }, STEP, PARK_TIMEOUT_MS)
      if (!parked.waiting) {
        report.expect('ownership.aRunFinished', false, { reason: 'never reached waiting', lastStatus: parked.lastStatus, snapshot: parked.snapshot })
        return
      }
      let aToken = appToken(env)
      if (!aToken) {
        const t = await mintFor(a!, args.harness, 'A')
        aMintedId = t.id
        aToken = t.token
      }
      // A's own tab still holds this run's lease — close it (as `mcp.ts`'s
      // park does) before submitting over MCP, or the submit is refused with
      // "A harness tab still drives this run…". Whatever happens next, A
      // gets a fresh session back (`withReopenedSession`'s `finally`) — D29
      // .inputsStaySigned and (when A holds the all-scope role)
      // D27.scopeAllAsked still read as A later in this walk, and the token
      // above (if minted) is revoked in the walk's own final cleanup via
      // `revokeToken`, through whichever session is live then, not through
      // `MintedToken.revoke`'s own now-dead request client.
      await a!.close()
      await withReopenedSession(
        async () => {
          const mcpA = await openMcp(args.harness, { token: aToken })
          try {
            const call: Call = async (name, toolArgs = {}) => (await mcpA.client.callTool({ name, arguments: toolArgs })) as ToolAnswer
            // `submitStepPastLease` absorbs the ~60s the lease can still take to lapse after the close.
            const answered = await submitStepPastLease(call, runIdA, STEP, { note: NOTE })
            const done = await pollStatus(call, runIdA, (s) => s.status !== 'running' && s.status !== 'pending', POLL_TIMEOUT_MS)
            report.expect('ownership.aRunFinished', !answered.isError && done?.status === 'succeeded', { submitStep: brief(answered), snapshot: done })
          } finally {
            await mcpA.close()
          }
        },
        async () => {
          a = await openSession({ base: args.harness, out: args.out, ...aLogin })
        },
      )
    })

    // =====================================================================
    // Member B: a fresh, independent browser context — no shared cookie jar
    // =====================================================================
    b = await openSession({ base: args.harness, out: args.out, ...bLogin })
    const bWho = await whoAmI(b)
    const bIsAllScope = ALL_SCOPE_ROLES.has(String(bWho.projectRole ?? '').toLowerCase())

    await report.guard(['D26.listDefaultsToMine'], async () => {
      const res = await b!.api.json(`/api/workflow/runs?impl=${IMPL}&workflow=${WORKFLOW}`)
      const ids = runIdsOf(res.body)
      report.expect('D26.listDefaultsToMine', res.status === 200 && !ids.includes(runIdA), { status: res.status, ids })
    })

    await report.guard(['D26.runGetIsNotFound'], async () => {
      const res = await b!.api.json(`/api/workflow/run?id=${encodeURIComponent(runIdA)}`)
      const body = res.body as { run?: unknown } | null
      report.expect('D26.runGetIsNotFound', res.status === 200 && body !== null && body.run === null, { status: res.status, body })
    })

    await report.guard(['D26.runUpdateIsNotFound'], async () => {
      const res = await b!.api.json('/api/workflow/run/update', { method: 'POST', body: { id: runIdA, patch: {} } })
      report.expect('D26.runUpdateIsNotFound', res.status === 404, { status: res.status, body: res.body })
    })

    await report.guard(['D29.signIsNotFound'], async () => {
      const path = `workflows/${IMPL}/${WORKFLOW}/runs/${runIdA}/x`
      const res = await b!.api.json('/api/workflow/files/sign', { method: 'POST', body: { path } })
      report.expect('D29.signIsNotFound', res.status === 404, { status: res.status, path, body: res.body })
    })

    // The per-workflow `inputs/` area carries no runId and stays member-wide
    // (D18) — only worth signing as B if A's run actually references a file
    // there. `hello/driven`'s only input is a plain string (`greeting`), so
    // this ordinarily has nothing to find and skips with a note.
    await report.guard(['D29.inputsStaySigned'], async () => {
      const record = await a!.api.json(`/api/workflow/run?id=${encodeURIComponent(runIdA)}`)
      const runRow = fieldsOf(((record.body as { run?: Record<string, unknown> } | null)?.run) ?? {})
      const inputs = runRow.inputs && typeof runRow.inputs === 'object' ? (runRow.inputs as Record<string, unknown>) : {}
      const inputsKey = Object.values(inputs).find((v): v is string => typeof v === 'string' && new RegExp(`^workflows/${IMPL}/${WORKFLOW}/inputs/`).test(v))
      if (!inputsKey) {
        report.note(`no workflows/${IMPL}/${WORKFLOW}/inputs/… reference in this run's inputs (${JSON.stringify(inputs)}) — skipping D29.inputsStaySigned`)
        return
      }
      const res = await b!.api.json('/api/workflow/files/sign', { method: 'POST', body: { path: inputsKey } })
      report.expect('D29.inputsStaySigned', res.status === 200 || res.status === 400, { status: res.status, path: inputsKey, body: res.body })
    })

    if (bIsAllScope) {
      report.note(`member B holds projectRole=${bWho.projectRole} (owner/admin) — asserting D27.scopeAllListsAll instead of D27.scopeAllIsForbiddenForAMember`)
      await report.guard(['D27.scopeAllListsAll'], async () => {
        const res = await b!.api.json(`/api/workflow/runs?impl=${IMPL}&workflow=${WORKFLOW}&scope=all`)
        const ids = runIdsOf(res.body)
        report.expect('D27.scopeAllListsAll', res.status === 200 && ids.includes(runIdA), { status: res.status, ids })
      })
    } else {
      await report.guard(['D27.scopeAllIsForbiddenForAMember'], async () => {
        const res = await b!.api.json(`/api/workflow/runs?impl=${IMPL}&workflow=${WORKFLOW}&scope=all`)
        report.expect('D27.scopeAllIsForbiddenForAMember', res.status === 403, { status: res.status, body: res.body, projectRole: bWho.projectRole ?? null })
      })
    }

    const aIsAllScope = ALL_SCOPE_ROLES.has(String(who.projectRole ?? '').toLowerCase())
    if (!aIsAllScope) {
      report.note(`member A holds projectRole=${who.projectRole ?? '(none)'} — not owner/admin, so D27.scopeAllAsked cannot be exercised on this harness; skipping`)
    } else {
      let runIdB = ''
      const startedB = await report.guard(['ownership.bRunStarted'], async () => {
        runIdB = await startDrivenRunOnPage(b!, '02-b-started')
        report.expect('ownership.bRunStarted', runIdB !== '', { runId: runIdB })
      })
      if (!startedB || runIdB === '') {
        report.note("member A holds the all-scope role but member B's own run could not be started — skipping D27.scopeAllAsked")
      } else {
        report.run(runIdB)
        await report.guard(['D27.scopeAllAsked'], async () => {
          const mine = await a!.api.json(`/api/workflow/runs?impl=${IMPL}&workflow=${WORKFLOW}`)
          const all = await a!.api.json(`/api/workflow/runs?impl=${IMPL}&workflow=${WORKFLOW}&scope=all`)
          const mineIds = runIdsOf(mine.body)
          const allIds = runIdsOf(all.body)
          report.expect('D27.scopeAllAsked', mine.status === 200 && all.status === 200 && !mineIds.includes(runIdB) && allIds.includes(runIdB), {
            mine: { status: mine.status, ids: mineIds },
            all: { status: all.status, ids: allIds },
            runIdB,
          })
        })
      }
    }

    // `workflow.outputs`, not `workflow.status`: `reply.ts` routes an unresolved
    // run through `pendingOr`, which answers a 200 `pending` snapshot for any id
    // minted inside `PENDING_WINDOW_MS` (10 minutes) — and member A's run was
    // minted minutes ago, so `status` would report "pending. Poll again", not the
    // refusal. `outputs` shares the same `resolveRun` but returns its refusal
    // directly with no pending path, so it is the tool that proves D26 over MCP.
    await report.guard(['D26.mcpOutputsIsNotFound'], async () => {
      let bToken: string
      try {
        const existing = secondAppToken(env)
        if (existing) {
          bToken = existing
        } else {
          const t = await mintFor(b!, args.harness, 'B')
          minted.push(t) // b stays open to the walk's own final cleanup, so t.revoke()'s request client is still live there
          bToken = t.token
        }
      } catch (e) {
        if (!isNotAProjectMember(e)) throw e
        // A missing precondition, not a gate failure: the six ownership
        // assertions already ran (or are still to run) with no need for B to
        // mint a token. Note it and skip — never report.block, which would
        // read as the whole walk being unable to proceed.
        report.note(
          'member B could not mint an app token (403 "You are not a member of this project") — B can log in but is not a member of the harness project. Fix: add member B to the project (any role — viewer is enough) in admin → project → members, or set WORKFLOW_APP_TOKEN_2. Skipping D26.mcpOutputsIsNotFound.',
        )
        return
      }
      const mcpB = await openMcp(args.harness, { token: bToken })
      try {
        const outputs = (await mcpB.client.callTool({ name: 'workflow.outputs', arguments: { runId: runIdA } })) as ToolAnswer
        report.expect('D26.mcpOutputsIsNotFound', outputs.isError === true && errorsOf(outputs).runId === 'No such run', { ...brief(outputs), errors: errorsOf(outputs) })
      } finally {
        await mcpB.close()
      }
    })
  } finally {
    if (aMintedId) await revokeToken(a, args.harness, aMintedId)
    for (const t of minted) await t.revoke()
    await a?.close()
    await b?.close()
  }
}
