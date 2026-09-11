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
 * holds the role — A reading B's). D29 (files follow the run): a run path
 * under `runs/<id>/` is gated exactly like the record; the workflow-wide
 * `inputs/` area is not run-scoped (D18) and stays member-wide, so B can
 * sign into it.
 */
import { appToken, credentials, secondAppToken, secondCredentials } from '../env.js'
import { openMcp } from '../mcp-client.js'
import { openSession, sessionLogin, type Session } from '../session.js'
import { waitStepState } from '../steps.js'
import { pollStatus } from './driven.js'
import { mintAppToken, WALK_SCOPES, type MintedToken } from '../token.js'
import type { Walk } from './index.js'

const IMPL = 'hello'
const WORKFLOW = 'driven'
const WORKFLOW_LINK = 'Driven hello'
const STEP = 'ask/0/answer'
const NOTE = 'from the ownership walk'
const ALL_SCOPE_ROLES = new Set(['owner', 'admin'])
const POLL_TIMEOUT_MS = 8 * 60_000

interface Who { id?: string; email?: string; role?: string; projectRole?: string }
interface ToolAnswer { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }

const text = (r: ToolAnswer) => (r.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
const structured = (r: ToolAnswer) => r.structuredContent ?? {}
const errorsOf = (r: ToolAnswer) => (structured(r).errors ?? {}) as Record<string, string>
const brief = (r: ToolAnswer) => ({ isError: r.isError ?? false, text: text(r).slice(0, 300) })

/** A record's columns: flattened onto the row, or nested under `fields` — every rule in this set tolerates both. */
const fieldsOf = (row: Record<string, unknown>): Record<string, unknown> => {
  const f = row.fields
  return f && typeof f === 'object' && Object.keys(f as object).length > 0 ? (f as Record<string, unknown>) : row
}
/** `runs/get` answers a bare array (`shape.fn.js`); a JSON parse failure or an error body is `[]`, not a throw. */
const rowsOf = (body: unknown): Record<string, unknown>[] => (Array.isArray(body) ? (body as Record<string, unknown>[]) : [])
const runIdsOf = (body: unknown): unknown[] => rowsOf(body).map((r) => fieldsOf(r).runId)

async function whoAmI(s: Session): Promise<Who> {
  const res = await s.api.json('/api/workflow/whoami')
  return (res.body as Who | null) ?? {}
}

/** Mint an app token through a signed-in browser context — `token.ts`'s mechanics, as `driven`/`mcp` use them. */
async function mintFor(s: Session, harness: string, label: string, minted: MintedToken[]): Promise<string> {
  const project = await s.api.json('/api/workflow/project')
  const repository = String((project.body as { repository?: string } | null)?.repository ?? '')
  if (repository === '') throw new Error(`GET /api/workflow/project answered no repository — cannot bind a token (${label})`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const t = await mintAppToken(s.request, harness, repository, [...WALK_SCOPES], `workflow-live ownership ${label} ${stamp}`)
  minted.push(t)
  return t.token
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
      await waitStepState(a!.page, STEP, 'waiting', POLL_TIMEOUT_MS)
      const aToken = appToken(env) ?? (await mintFor(a!, args.harness, 'A', minted))
      const mcpA = await openMcp(args.harness, { token: aToken })
      try {
        const call = async (name: string, toolArgs: Record<string, unknown> = {}) => (await mcpA.client.callTool({ name, arguments: toolArgs })) as ToolAnswer
        const answered = await call('workflow.submitStep', { runId: runIdA, step: STEP, values: { note: NOTE } })
        const done = await pollStatus(call, runIdA, (s) => s.status !== 'running' && s.status !== 'pending', POLL_TIMEOUT_MS)
        report.expect('ownership.aRunFinished', !answered.isError && done?.status === 'succeeded', { submitStep: brief(answered), snapshot: done })
      } finally {
        await mcpA.close()
      }
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

    await report.guard(['D26.mcpStatusIsNotFound'], async () => {
      const bToken = secondAppToken(env) ?? (await mintFor(b!, args.harness, 'B', minted))
      const mcpB = await openMcp(args.harness, { token: bToken })
      try {
        const status = (await mcpB.client.callTool({ name: 'workflow.status', arguments: { runId: runIdA } })) as ToolAnswer
        report.expect('D26.mcpStatusIsNotFound', status.isError === true && errorsOf(status).runId === 'No such run', { ...brief(status), errors: errorsOf(status) })
      } finally {
        await mcpB.close()
      }
    })
  } finally {
    for (const t of minted) await t.revoke()
    await a?.close()
    await b?.close()
  }
}
