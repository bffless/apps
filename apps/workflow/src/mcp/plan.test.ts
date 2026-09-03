// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RUN_ID, runRow, stepRows } from './fixtures/index'
import { aliasNames, handler, queryOf } from './plan'
import { TOOLS_PATH, handler as routeOf, type FnRequest } from './route'

const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }
const HEADERS = { host: 'h.example' }
const request = (name: string, body: unknown): FnRequest => ({ body, headers: HEADERS, method: 'POST', path: `${TOOLS_PATH}${name.replace(/^workflow\./, '')}` })
const call = (name: string, args: Record<string, unknown> = {}) =>
  routeOf({ request: request(name, args), deployment: DEPLOYMENT })

const aliases = (...names: string[]) => ({ ok: true, status: 200, body: { data: names.map((alias) => ({ alias })) } })

describe('plan: list fan-out', () => {
  it('fetches up to three implementation indexes, skipping the harness alias and reporting the rest', () => {
    const plan = handler({ steps: { route: call('workflow.list'), aliases: aliases('workflow', 'hello', 'a', 'b', 'c') }, deployment: DEPLOYMENT })
    expect(plan.aliases).toEqual(['hello', 'a', 'b'])
    expect(plan.skipped).toEqual(['c'])
    expect([plan.has1, plan.has2, plan.has3]).toEqual([true, true, true])
    expect(plan.url1).toBe('https://h.example/w/hello/.bffless/workflows/index.json')
    expect(plan.url3).toBe('https://h.example/w/b/.bffless/workflows/index.json')
  })

  it('fetches exactly one index when impl is given', () => {
    const plan = handler({ steps: { route: call('workflow.list', { impl: 'hello' }), aliases: aliases('workflow', 'hello', 'a') }, deployment: DEPLOYMENT })
    expect(plan.aliases).toEqual(['hello'])
    expect([plan.has1, plan.has2, plan.has3]).toEqual([true, false, false])
    expect(plan.skipped).toEqual([])
  })

  it('plans nothing when the alias relay failed', () => {
    const plan = handler({ steps: { route: call('workflow.list'), aliases: { ok: false, status: 401, body: 'unauthorised' } }, deployment: DEPLOYMENT })
    expect(plan.aliases).toEqual([])
    expect(plan.has1).toBe(false)
  })

  it('reads either alias envelope', () => {
    expect(aliasNames({ data: [{ alias: 'a' }, { nope: 1 }] })).toEqual(['a'])
    expect(aliasNames([{ alias: 'b' }])).toEqual(['b'])
    expect(aliasNames('x')).toEqual([])
  })
})

describe('plan: describe', () => {
  const index = { ok: true, status: 200, body: { impl: 'hello', workflows: [{ file: 'hello.workflow.yaml', name: 'Hello' }, { file: 'interactive.workflow.yaml', name: 'Interactive hello', headlessSafe: true }] } }

  it("names the YAML by the index's file, not by a guess", () => {
    const plan = handler({ steps: { route: call('workflow.describe', { impl: 'hello', workflow: 'interactive' }), index }, deployment: DEPLOYMENT })
    expect(plan.hasYaml).toBe(true)
    expect(plan.yamlUrl).toBe('https://h.example/w/hello/.bffless/workflows/interactive.workflow.yaml')
    expect(plan.listing).toMatchObject({ name: 'Interactive hello', headlessSafe: true })
  })

  it('has no YAML for a workflow the index does not list, or a failed index', () => {
    expect(handler({ steps: { route: call('workflow.describe', { impl: 'hello', workflow: 'nope' }), index }, deployment: DEPLOYMENT }).hasYaml).toBe(false)
    expect(handler({ steps: { route: call('workflow.describe', { impl: 'hello', workflow: 'interactive' }), index: { ok: false, status: 404, body: '' } }, deployment: DEPLOYMENT }).hasYaml).toBe(false)
  })
})

describe('plan: island resources', () => {
  const run = [runRow()]
  const steps = stepRows()

  it("names the waiting step's island file through resolveSrc against the run's impl", () => {
    const plan = handler({ steps: { route: call('workflow.stepView', { runId: RUN_ID, step: 'pick/0/choose' }), run, steps }, deployment: DEPLOYMENT })
    expect(plan.hasIsland).toBe(true)
    expect(plan.islandUrl).toBe('https://h.example/w/hello/islands/pick-line.html')
    const gone = handler({ steps: { route: call('workflow.stepView', { runId: RUN_ID, step: 'nope/0/x' }), run, steps }, deployment: DEPLOYMENT })
    expect(gone.hasIsland).toBe(false)
    expect(gone.islandError).toBe('No such step: nope/0/x')
    const escaped = handler({ steps: { route: call('workflow.stepView', { runId: RUN_ID, step: 'pick/0/choose' }), run: [runRow({ definition: { jobs: { pick: { steps: [{ id: 'choose', with: { src: '../other/x.html' } }] } } } })], steps }, deployment: DEPLOYMENT })
    expect(escaped.hasIsland).toBe(false)
    expect(escaped.islandError).toContain('must resolve inside /w/hello/')
    expect(handler({ steps: { route: call('workflow.stepView', { runId: 'nope', step: 'pick/0/choose' }), run: [], steps: [] }, deployment: DEPLOYMENT }).islandError).toBe('No such run: nope')
  })

  it('resolves a pipeline name exactly as IslandHost does, and refuses what it refuses', () => {
    const post = handler({ steps: { route: call('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name: 'echo', arguments: { text: 'hi', upper: true } }), run, steps }, deployment: DEPLOYMENT })
    expect(post.isPipelinePost).toBe(true)
    expect(post.pipelineUrl).toBe('https://h.example/api/hello/echo')
    expect(post.pipelineBody).toEqual({ text: 'hi', upper: true })
    const get = handler({ steps: { route: call('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name: 'job', arguments: { id: '7' }, method: 'GET' }), run, steps }, deployment: DEPLOYMENT })
    expect(get.isPipelineGet).toBe(true)
    expect(get.pipelineUrl).toBe('https://h.example/api/hello/job?id=7')
    const dotted = handler({ steps: { route: call('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name: 'video.slice' }), run, steps }, deployment: DEPLOYMENT })
    expect(dotted.pipelineUrl).toBe('https://h.example/api/hello/video/slice')
    for (const name of ['../workflow/run', '/api/other/x', '', 'a b']) {
      const bad = handler({ steps: { route: call('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name }), run, steps }, deployment: DEPLOYMENT })
      expect(bad.isPipelinePost || bad.isPipelineGet, name).toBe(false)
      expect(bad.pipelineError, name).not.toBe('')
    }
    const host = handler({ steps: { route: call('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name: 'workflow.submit' }), run, steps }, deployment: DEPLOYMENT })
    expect(host.pipelineError).toContain('host tool')
    expect(queryOf({ a: 1, b: 'x y' })).toBe('?a=1&b=x%20y')
  })
})
