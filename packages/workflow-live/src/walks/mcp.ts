/**
 * The MCP endpoint: the M5 Phase-2 walk (spec 10, D19/D22/D23; apps#554
 * stories 5–6). Talks to `POST /api/workflow/mcp` the way claude.ai's
 * connector does — the official SDK over stateless Streamable HTTP — and holds
 * the answers to the catalog and to the page's own wording. Story 5 covers
 * the protocol and the read tools; Story 6 adds the island round trip.
 *
 * The protocol and read checks need no browser or member: the endpoint is
 * authless by design on the scratch project it targets (auth ladder rung 1).
 * The Story 6 round trip parks a `hello/interactive` run **through the page
 * tools** (a member's browser, closed afterwards so the lease lapses), then
 * completes its island from outside: `stepView` → `pipeline` → `annotate` →
 * `submit` → the record. `--run <id>` skips the park; `--park-only` parks,
 * prints the run id and stops — how a person gets a fresh run to hand to
 * claude.ai. Check names cite the decision they prove; keep them stable.
 */
import { CATALOG } from '@bffless/workflow-agent-tools'
import { callPageTool, waitForPageTools } from '@bffless/workflow-headless'
import { writeFile } from 'node:fs/promises'
import { adminKey, credentials } from '../env.js'
import { cspOf, originOf, toolParity, type ListedTool } from '../mcp-checks.js'
import { openMcp, rawGet, rawPost } from '../mcp-client.js'
import { openSession } from '../session.js'
import type { Walk } from './index.js'

const APP_ONLY = ['workflow.submit', 'workflow.annotate', 'workflow.pipeline', 'workflow.stepView']
const STEP_VIEW_URI = 'ui://bffless/workflow/step.html'
const ISLAND_URI = 'ui://bffless/hello/islands/pick-line.html'

interface ToolAnswer {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}

const text = (r: ToolAnswer) => (r.content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
const structured = (r: ToolAnswer) => r.structuredContent ?? {}
const errorsOf = (r: ToolAnswer) => (structured(r).errors ?? {}) as Record<string, string>
const brief = (r: ToolAnswer) => ({ isError: r.isError ?? false, text: text(r).slice(0, 300) })

export const mcp: Walk = async ({ args, env, report }) => {
  const log: string[] = []
  const say = (line: string) => {
    log.push(line)
  }
  let session: Awaited<ReturnType<typeof openMcp>> | null = null
  try {
    // --- D22: the transport profile
    const url = `${args.harness}/api/workflow/mcp`
    const got = await rawGet(url)
    report.expect('D22.getIs405', got.status === 405 && /post/i.test(got.headers.allow ?? ''), { status: got.status, allow: got.headers.allow })
    say(`GET ${url} → ${got.status}`)

    try {
      session = await openMcp(args.harness)
    } catch (e) {
      report.block(`initialize failed against ${url}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const { client } = session
    const server = client.getServerVersion()
    report.expect('D22.initialize', server?.name === 'bffless-workflow', server)

    const call = async (name: string, toolArgs: Record<string, unknown> = {}): Promise<ToolAnswer> => {
      const answer = (await client.callTool({ name, arguments: toolArgs })) as ToolAnswer
      say(`tools/call ${name} ${JSON.stringify(toolArgs)} → ${answer.isError ? 'error' : 'ok'}: ${text(answer).slice(0, 120)}`)
      return answer
    }

    // --- D19: the catalog, byte for byte; the app-only four hidden from the model
    const listed = (await client.listTools()).tools as ListedTool[]
    const parity = toolParity(listed, CATALOG)
    report.expect('D19.toolsListParity', parity.length === 0 && listed.length === CATALOG.length + APP_ONLY.length, parity.length ? parity : listed.map((t) => t.name))
    const appOnly = listed.filter((tool) => (tool._meta?.ui?.visibility ?? []).includes('app')).map((tool) => tool.name).sort()
    const submitStep = listed.find((tool) => tool.name === 'workflow.submitStep')
    report.expect('spec10.appOnlyHidden', appOnly.join(',') === [...APP_ONLY].sort().join(',') && submitStep?._meta?.ui?.resourceUri === STEP_VIEW_URI, {
      appOnly,
      resourceUri: submitStep?._meta?.ui?.resourceUri,
    })

    // --- Discovery
    const list = await call('workflow.list')
    const impls = (structured(list).implementations ?? []) as Array<{ alias: string; workflows: Array<{ id: string; headlessSafe: unknown }> }>
    const hello = impls.find((impl) => impl.alias === 'hello')
    const interactive = hello?.workflows.find((workflow) => workflow.id === 'interactive')
    report.expect('D19.listsHello', !list.isError && !!interactive && typeof interactive.headlessSafe === 'boolean', { ...brief(list), aliases: impls.map((impl) => impl.alias) })

    const describe = await call('workflow.describe', { impl: 'hello', workflow: 'interactive' })
    const described = structured(describe) as { jobs?: Array<{ id: string; steps: Array<{ id: string; kind: string; headless?: string }> }> }
    const choose = described.jobs?.find((job) => job.id === 'pick')?.steps.find((step) => step.id === 'choose')
    report.expect('D20.describeInteractive', !describe.isError && described.jobs?.map((job) => job.id).join(',') === 'greet,analyze,pick,card,review' && choose?.kind === 'island' && choose.headless === 'auto', {
      ...brief(describe),
      jobs: described.jobs?.map((job) => job.id),
      choose,
    })

    // --- Run-scoped reads: runId is required over the endpoint (spec 10)
    const noImpl = await call('workflow.runs', {})
    const runs = await call('workflow.runs', { impl: 'hello', workflow: 'interactive' })
    const listedRuns = (structured(runs).runs ?? []) as Array<{ runId: string; status: string }>
    report.expect('spec10.runsRequiresImpl', noImpl.isError === true && 'workflow' in errorsOf(noImpl) && !runs.isError && Array.isArray(structured(runs).runs), {
      refusal: brief(noImpl),
      ...brief(runs),
      count: listedRuns.length,
    })

    const runId = args.run ?? listedRuns[0]?.runId
    const noRun = await call('workflow.status', {})
    if (runId) {
      const status = await call('workflow.status', { runId })
      const snapshot = structured(status) as { runId?: string; steps?: Record<string, string> }
      report.expect('spec10.statusRequiresRunId', noRun.isError === true && 'runId' in errorsOf(noRun) && !status.isError && snapshot.runId === runId && typeof snapshot.steps === 'object', {
        refusal: brief(noRun),
        ...brief(status),
      })
      const outputs = await call('workflow.outputs', { runId })
      report.expect('spec10.outputsOfRun', !outputs.isError && structured(outputs).runId === runId && typeof structured(outputs).outputs === 'object', brief(outputs))
    } else {
      const unknown = await call('workflow.status', { runId: 'run_does_not_exist' })
      report.expect('spec10.statusRequiresRunId', noRun.isError === true && 'runId' in errorsOf(noRun) && unknown.isError === true && /No such run/.test(text(unknown)), {
        refusal: brief(noRun),
        unknown: brief(unknown),
        note: 'no runs on this harness yet — pass --run <id> to read a real one',
      })
      report.expect('spec10.outputsOfRun', /No such run/.test(text(await call('workflow.outputs', { runId: 'run_does_not_exist' }))), { note: 'no runs on this harness yet' })
    }

    // --- Files: the same presigned GET islands get (D6), through the same confinement
    const signed = await call('workflow.sign', { path: `workflows/hello/interactive/runs/${runId ?? 'walk'}/probe.svg` })
    const signedUrl = String(structured(signed).url ?? '')
    const storageOrigin = originOf(signedUrl)
    const refused = await call('workflow.sign', { path: '../x' })
    report.expect('D6.signIsPresigned', !signed.isError && /^https:/.test(storageOrigin) && structured(signed).expiresIn === 3600 && refused.isError === true && 'path' in errorsOf(refused), {
      ...brief(signed),
      origin: storageOrigin,
      refused: brief(refused),
    })

    // --- Honesty: what this build does not serve says so as a tool error, never a protocol error
    const start = await call('workflow.start', { impl: 'hello', workflow: 'interactive', inputs: {} })
    report.expect('spec10.notServedHonest', start.isError === true && 'tool' in errorsOf(start) && /Phase 4/.test(text(start)), brief(start))

    // --- Resources: the step view and the islands, each with a CSP derived from the instance
    const resources = (await client.listResources()).resources as Array<{ uri: string; mimeType?: string; _meta?: unknown }>
    const uris = resources.map((r) => r.uri)
    const harnessOrigin = originOf(args.harness)
    const everyCsp = resources.every((r) => {
      const csp = cspOf(r)
      return r.mimeType === 'text/html;profile=mcp-app' && !!csp && csp.connectDomains[0] === harnessOrigin && csp.connectDomains[1] === storageOrigin && csp.resourceDomains[0] === storageOrigin
    })
    report.expect('spec10.resourcesList', uris.includes(STEP_VIEW_URI) && uris.includes(ISLAND_URI) && everyCsp, { uris, csp: cspOf(resources[0]), harnessOrigin, storageOrigin })

    // --- JSON-RPC: an unknown method is -32601 (the SDK would throw; ask by hand)
    const unknown = await rawPost(session.url, { id: 99, method: 'prompts/list' })
    const code = (unknown.body as { error?: { code?: number } } | null)?.error?.code
    report.expect('D22.unknownMethod', unknown.status === 200 && code === -32601, { status: unknown.status, body: unknown.body })

    // =====================================================================
    // Story 6 — an island completed from outside the harness page
    // =====================================================================
    const STEP = 'pick/0/choose'
    let parked = args.run
    if (!parked) {
      const creds = credentials(env)
      if (!creds) return report.block('WORKFLOW_EMAIL/WORKFLOW_PASSWORD missing (needed to park a run through the page tools)')
      const s = await openSession({ base: args.harness, out: args.out, credentials: creds })
      try {
        await waitForPageTools(s.page, { timeoutMs: 30_000 })
        const started = await callPageTool(s.page, 'workflow.start', { impl: 'hello', workflow: 'interactive', inputs: { greeting: 'Hello', names: ['world', 'studio'] } })
        const waiting = await callPageTool(s.page, 'workflow.await', { until: 'waiting', timeoutMs: 120_000 })
        const waitingOn = ((waiting.structuredContent ?? {}) as { waitingOn?: Array<{ key: string; kind: string }> }).waitingOn ?? []
        parked = String(((started.structuredContent ?? {}) as { runId?: string }).runId ?? '')
        // The page answers `await` from its store; the `waiting` row lands a
        // beat later (the middleware's run-step upsert). The endpoint reads rows,
        // so the browser stays open until the row says what the page says.
        let rowStatus = ''
        const rowStart = Date.now()
        while (parked !== '' && Date.now() - rowStart < 30_000 && rowStatus !== 'waiting') {
          const record = await s.api.json(`/api/workflow/run?id=${encodeURIComponent(parked)}`)
          const rows = ((record.body as { steps?: Array<Record<string, unknown>> } | null)?.steps ?? []).map((r) => (r.fields && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : r))
          rowStatus = String(rows.find((r) => r.key === STEP)?.status ?? '')
          if (rowStatus !== 'waiting') await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        report.expect('spec10.parkIsland', !started.isError && !waiting.isError && parked !== '' && waitingOn[0]?.key === STEP && waitingOn[0].kind === 'island' && rowStatus === 'waiting', {
          runId: parked,
          waitingOn,
          rowStatus,
          rowWaitMs: Date.now() - rowStart,
        })
        await s.shot('01-parked')
      } finally {
        await s.close() // the driver goes away; the lease lapses within 60 s
      }
      if (parked === '') return report.block('no run was parked')
      say(`parked ${parked} on ${STEP}`)
      if (args.parkOnly) {
        report.note(`parked run ${parked}, waiting on ${STEP} — hand it to the agent host`)
        console.log(`parked ${parked}`)
        return
      }
    } else {
      report.note(`using --run ${parked} (not parked by this walk)`)
    }

    // --- the lease lapses: a submit probe is refused by validation, not by the lease
    const lapseStart = Date.now()
    let lapsed = false
    let lastProbe: ToolAnswer = { content: [] }
    while (Date.now() - lapseStart < 90_000) {
      lastProbe = await call('workflow.submit', { runId: parked, step: STEP, outputs: {} })
      if (!('lease' in errorsOf(lastProbe))) {
        lapsed = 'line' in errorsOf(lastProbe)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    report.expect('spec10.leaseLapses', lapsed, { waitedMs: Date.now() - lapseStart, probe: brief(lastProbe), errors: errorsOf(lastProbe) })

    // --- the island as a ui:// resource, unchanged, with the derived CSP
    const read = await client.readResource({ uri: ISLAND_URI })
    const content = read.contents[0] as { uri: string; mimeType?: string; text?: string; _meta?: unknown } | undefined
    const islandText = content?.text ?? ''
    report.expect('spec10.resourcesReadIsland', content?.uri === ISLAND_URI && content?.mimeType === 'text/html;profile=mcp-app' && islandText.includes('pick-line') && islandText.includes('<script'), {
      uri: content?.uri,
      mimeType: content?.mimeType,
      bytes: islandText.length,
    })
    const readCsp = cspOf(content)
    report.expect('spec10.cspDerived', !!readCsp && readCsp.connectDomains[0] === harnessOrigin && readCsp.connectDomains[1] === storageOrigin, { csp: readCsp, harnessOrigin, storageOrigin })

    // --- what the step view mounts
    const view = await call('workflow.stepView', { runId: parked, step: STEP })
    const v = structured(view) as { html?: string; arguments?: { lines?: unknown }; outputs?: Record<string, unknown>; src?: string; impl?: string }
    report.expect('spec10.stepViewMounts', !view.isError && v.impl === 'hello' && v.src === 'islands/pick-line.html' && Array.isArray(v.arguments?.lines) && v.arguments.lines.length === 2 && !!v.outputs?.line && (v.html ?? '').includes('pick-line'), {
      ...brief(view),
      lines: v.arguments?.lines,
      outputs: v.outputs && Object.keys(v.outputs),
      htmlBytes: (v.html ?? '').length,
    })

    // --- the island's own pipeline, fenced to its implementation
    const echoed = await call('workflow.pipeline', { runId: parked, step: STEP, name: 'echo', arguments: { text: 'hi', upper: true } })
    const outside = await call('workflow.pipeline', { runId: parked, step: STEP, name: '../workflow/run' })
    report.expect('spec10.pipelineFenced', !echoed.isError && structured(echoed).text === 'HI' && outside.isError === true && /resolves outside/.test(text(outside)), {
      echoed: brief(echoed),
      outside: brief(outside),
    })

    // --- annotate, refuse a bad submit, submit
    const annotated = await call('workflow.annotate', { runId: parked, step: STEP, annotations: [{ level: 'notice', message: 'from the mcp walk' }] })
    report.expect('spec10.annotateWrites', !annotated.isError && text(annotated) === 'ok', brief(annotated))
    const bad = await call('workflow.submit', { runId: parked, step: STEP, outputs: {} })
    report.expect('spec10.submitRefusesBad', bad.isError === true && errorsOf(bad).line === 'This field is required', { ...brief(bad), errors: errorsOf(bad) })
    const submittedAnswer = await call('workflow.submit', { runId: parked, step: STEP, outputs: { line: 'Hello, world!', index: 0 } })
    report.expect('spec10.submitWrites', !submittedAnswer.isError && text(submittedAnswer).startsWith(`Submitted ${STEP}`), brief(submittedAnswer))

    // --- the record: the row is succeeded with the outputs and the annotation; the run is still running (no driver sealed it)
    const key = adminKey(env)
    if (key) {
      const res = await fetch(`${args.harness}/api/workflow/run?id=${encodeURIComponent(parked)}`, { headers: { 'x-api-key': key } })
      const record = (await res.json().catch(() => null)) as { run?: { status?: string }; steps?: Array<Record<string, unknown>> } | null
      const rowOf = (r: Record<string, unknown>) => (r.fields && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : r)
      const row = (record?.steps ?? []).map(rowOf).find((r) => r.key === STEP)
      const outputs = (row?.outputs ?? {}) as { line?: unknown }
      const annotations = (row?.annotations ?? []) as Array<{ message?: string }>
      report.expect('record.stepSucceeded', res.status === 200 && row?.status === 'succeeded' && outputs.line === 'Hello, world!' && annotations.some((a) => a.message === 'from the mcp walk') && record?.run?.status === 'running', {
        status: res.status,
        row: row && { status: row.status, outputs: row.outputs, annotations: annotations.length },
        run: record?.run?.status,
      })
    } else {
      const after = await call('workflow.status', { runId: parked })
      const snap = structured(after) as { status?: string; steps?: Record<string, string> }
      report.expect('record.stepSucceeded', !after.isError && snap.steps?.[STEP] === 'succeeded' && snap.status === 'running', { ...brief(after), note: 'no ADMIN_API_KEY — the snapshot stands in for the row' })
    }
    const again = await call('workflow.submit', { runId: parked, step: STEP, outputs: { line: 'Hello, world!', index: 0 } })
    report.expect('spec10.submitTwiceRefused', again.isError === true && errorsOf(again).step === `${STEP} is succeeded, not waiting`, { ...brief(again), errors: errorsOf(again) })
  } finally {
    await writeFile(`${args.out}/mcp.log`, log.join('\n'), 'utf8').catch(() => undefined)
    await session?.close()
  }
}
