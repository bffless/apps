/**
 * The MCP endpoint: the M5 Phase-2 walk (spec 10, D19/D22/D23; apps#554
 * stories 5–6). Talks to `POST /api/workflow/mcp` the way claude.ai's
 * connector does — the official SDK over stateless Streamable HTTP — and holds
 * the answers to the catalog and to the page's own wording. Story 5 covers
 * the protocol and the read tools; Story 6 adds the island round trip.
 *
 * Nothing here needs a browser or a member: the endpoint is authless by
 * design on the scratch project it targets (auth ladder rung 1). Check names
 * cite the decision they prove; keep them stable once shipped.
 */
import { CATALOG } from '@bffless/workflow-agent-tools'
import { writeFile } from 'node:fs/promises'
import { cspOf, originOf, toolParity, type ListedTool } from '../mcp-checks.js'
import { openMcp, rawGet, rawPost } from '../mcp-client.js'
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

export const mcp: Walk = async ({ args, report }) => {
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
  } finally {
    await writeFile(`${args.out}/mcp.log`, log.join('\n'), 'utf8').catch(() => undefined)
    await session?.close()
  }
}
