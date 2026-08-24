/**
 * The data layer end-to-end against the MSW mock backend: discovery (06),
 * the workflow YAML fetch, and the two read endpoints over the run record (05).
 */
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedFinishedRun } from '../mocks/db'
import { FINISHED_RUN } from '../mocks/fixtures/finishedRun'
import { server } from '../mocks/server'
import { makeStore } from './index'
import { workflowApi } from './workflowApi'

function store() {
  return makeStore()
}

describe('discover', () => {
  it('lists the aliases that answer with an index.json, and only those', async () => {
    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(res.data).toHaveLength(1)
    const [impl] = res.data!
    expect(impl.alias).toBe('hello')
    expect(impl.name).toBe('Hello')
    expect(impl.preview).toBe(false)
    expect(impl.error).toBeUndefined()
    expect(impl.workflows).toEqual([
      {
        file: 'hello.workflow.yaml',
        name: 'Hello workflow',
        description: 'Smoke-tests every non-interactive feature of the harness.',
        inputs: 4,
        jobs: 4,
        headlessSafe: true,
      },
    ])
  })

  it('keeps a reachable-but-invalid implementation, with its error (08)', async () => {
    server.use(
      http.get('/api/workflow/aliases', () =>
        HttpResponse.json([
          { name: 'hello', isAutoPreview: false },
          { name: 'broken', isAutoPreview: true },
        ]),
      ),
      // JSON, so it *is* a publish — just not one this harness can read.
      http.get('/w/broken/.bffless/workflows/index.json', () => HttpResponse.json('nope')),
    )

    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(res.data?.map((i) => i.alias)).toEqual(['hello', 'broken'])
    const broken = res.data!.find((i) => i.alias === 'broken')!
    expect(broken.error).toBeTruthy()
    expect(broken.preview).toBe(true)
    expect(broken.workflows).toEqual([])
  })

  it('drops an ordinary SPA deploy that answers its index.html (ADR-0004)', async () => {
    server.use(
      http.get('/api/workflow/aliases', () =>
        HttpResponse.json([
          { name: 'hello', isAutoPreview: false },
          { name: 'spa', isAutoPreview: false },
        ]),
      ),
      // What a BFFless SPA serves for any unknown path: 200, but HTML.
      http.get('/w/spa/.bffless/workflows/index.json', () =>
        HttpResponse.html('<!doctype html><html><body>app</body></html>'),
      ),
    )

    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(res.data?.map((i) => i.alias)).toEqual(['hello'])
  })

  it('keeps a JSON index it cannot use', async () => {
    server.use(
      http.get('/api/workflow/aliases', () => HttpResponse.json([{ name: 'future', isAutoPreview: false }])),
      http.get('/w/future/.bffless/workflows/index.json', () => HttpResponse.json({ spec: 2 })),
    )

    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(res.data).toHaveLength(1)
    expect(res.data?.[0]).toMatchObject({ alias: 'future', workflows: [] })
    expect(res.data?.[0].error).toContain('spec')
  })

  it('keeps an alias whose JSON index does not parse', async () => {
    server.use(
      http.get('/api/workflow/aliases', () => HttpResponse.json([{ name: 'torn', isAutoPreview: false }])),
      http.get('/w/torn/.bffless/workflows/index.json', () =>
        HttpResponse.text('{"spec": 1, "workflows": [', { headers: { 'content-type': 'application/json' } }),
      ),
    )

    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(res.data?.[0].error).toBe('index.json is not valid JSON')
  })

  it('surfaces the aliases request failing as a query error', async () => {
    server.use(http.get('/api/workflow/aliases', () => new HttpResponse(null, { status: 500 })))

    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(res.data).toBeUndefined()
    expect(res.error).toBeTruthy()
  })
})

describe('getWorkflowYaml', () => {
  it('fetches the file named by the listing, as text', async () => {
    const res = await store().dispatch(
      workflowApi.endpoints.getWorkflowYaml.initiate({ impl: 'hello', file: 'hello.workflow.yaml' }),
    )

    expect(typeof res.data).toBe('string')
    expect(res.data).toContain('name: Hello workflow')
  })
})

describe('the run record', () => {
  beforeEach(() => {
    seedFinishedRun()
  })

  it('reads a run and all its step rows (R2: six)', async () => {
    const res = await store().dispatch(
      workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId),
    )

    expect(res.data?.run?.runId).toBe(FINISHED_RUN.run.runId)
    expect(res.data?.run?.workflowName).toBe('Hello workflow')
    expect(res.data?.steps).toHaveLength(6)
    expect(res.data?.steps.map((s) => s.key)).toContain('slow/0/start')
  })

  it('answers an unknown run with an empty record', async () => {
    const res = await store().dispatch(workflowApi.endpoints.getRun.initiate('run_nope'))

    expect(res.data).toEqual({ run: null, steps: [] })
  })

  it('lists one workflow’s runs, newest first', async () => {
    await fetch('/api/workflow/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...FINISHED_RUN.run,
        runId: 'run_older',
        startedAt: FINISHED_RUN.run.startedAt - 60_000,
      }),
    })
    await fetch('/api/workflow/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...FINISHED_RUN.run, runId: 'run_other', workflow: 'other' }),
    })

    const res = await store().dispatch(
      workflowApi.endpoints.listRuns.initiate({ impl: 'hello', workflow: 'hello' }),
    )

    expect(res.data?.map((r) => r.runId)).toEqual([FINISHED_RUN.run.runId, 'run_older'])
  })
})

describe('reauth', () => {
  it('refreshes the session once on a 401 and retries the request (R5)', async () => {
    seedFinishedRun()
    let refreshes = 0
    server.use(
      http.get('/api/workflow/run', () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.post('/api/auth/session/refresh', () => {
        refreshes += 1
        return new HttpResponse(null, { status: 200 })
      }),
    )

    const res = await store().dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId))

    expect(refreshes).toBe(1)
    expect(res.data?.run?.runId).toBe(FINISHED_RUN.run.runId)
  })

  it('gives up when the refresh fails', async () => {
    server.use(
      http.get('/api/workflow/run', () => new HttpResponse(null, { status: 401 })),
      http.post('/api/auth/session/refresh', () => new HttpResponse(null, { status: 401 })),
    )

    const res = await store().dispatch(workflowApi.endpoints.getRun.initiate('run_1'))

    expect(res.error).toMatchObject({ status: 401 })
  })
})
