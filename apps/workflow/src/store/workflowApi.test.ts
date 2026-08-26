/**
 * The data layer end-to-end against the MSW mock backend: discovery (06),
 * the workflow YAML fetch, and the two read endpoints over the run record (05).
 */
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, seedFinishedRun, stepRowKey } from '../mocks/db'
import { FINISHED_RUN } from '../mocks/fixtures/finishedRun'
import { HELLO_INDEX } from '../mocks/handlers'
import { fileUrl } from '../lib/coerce'
import type { FileRef } from '../lib/runner/types'
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
      {
        file: 'interactive.workflow.yaml',
        name: 'Interactive hello',
        description: 'Exercises every interactive feature of the harness (M2) — grows per phase.',
        inputs: 2,
        jobs: 5,
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

  it('keeps a probe that answers with a real error, rather than dropping it (M1 minor)', async () => {
    server.use(
      http.get('/api/workflow/aliases', () => HttpResponse.json([{ name: 'down', isAutoPreview: false }])),
      http.get('/w/down/.bffless/workflows/index.json', () => new HttpResponse(null, { status: 500 })),
    )

    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(res.data?.map((i) => i.alias)).toEqual(['down'])
    expect(res.data?.[0].error).toContain('500')
  })

  it('retries a probe once after a 401 instead of reading it as unpublished (M1 minor)', async () => {
    let refreshes = 0
    let calls = 0
    server.use(
      http.get('/w/hello/.bffless/workflows/index.json', () => {
        calls += 1
        return calls === 1 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json(HELLO_INDEX)
      }),
      http.post('/api/auth/session/refresh', () => {
        refreshes += 1
        return new HttpResponse(null, { status: 200 })
      }),
    )

    const res = await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(refreshes).toBe(1)
    expect(res.data?.map((i) => i.alias)).toEqual(['hello'])
  })
})

describe('discover — scoped to a project (apps#363)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('carries ?repository= when VITE_BFFLESS_PROJECT is set', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', 'bffless/workflow')
    let seenUrl = ''
    server.use(
      http.get('/api/workflow/aliases', ({ request }) => {
        seenUrl = request.url
        return HttpResponse.json([{ name: 'hello', isAutoPreview: false }])
      }),
    )

    await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(new URL(seenUrl).searchParams.get('repository')).toBe('bffless/workflow')
  })

  it('carries no ?repository= when VITE_BFFLESS_PROJECT is unset', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    let seenUrl = ''
    server.use(
      http.get('/api/workflow/aliases', ({ request }) => {
        seenUrl = request.url
        return HttpResponse.json([{ name: 'hello', isAutoPreview: false }])
      }),
    )

    await store().dispatch(workflowApi.endpoints.discover.initiate())

    expect(new URL(seenUrl).searchParams.has('repository')).toBe(false)
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

/**
 * Task 13: an output the writer offloaded (`{"$file": ref}`, payload.ts) is a
 * pointer in the row and a value everywhere above this module — so the read
 * path dereferences it exactly once, here.
 */
describe('the run record — {"$file"} hydration', () => {
  /** Put JSON in the mock bucket at `path` and hand back the ref a row would carry. */
  function seedPayload(path: string, value: unknown): FileRef {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    db.files.set(path, { bytes, contentType: 'application/json' })
    return {
      path,
      name: path.split('/').pop() ?? path,
      contentType: 'application/json',
      size: bytes.byteLength,
      url: fileUrl(path),
    }
  }

  /** A coerced row's `outputs` — declared `unknown` on the row interface, always a record here. */
  const outputsOf = (row: { outputs?: unknown }) => (row.outputs ?? {}) as Record<string, unknown>

  const REPORT = '## The offloaded report'
  const LINES = ['Hello, world!', 'Hello, studio!']

  beforeEach(() => {
    seedFinishedRun()
  })

  function offload(): void {
    const stepRef = seedPayload('workflows/hello/hello/runs/x/slow/0/start/report.json', REPORT)
    const runRef = seedPayload('workflows/hello/hello/runs/x/outputs/lines.json', LINES)

    const key = stepRowKey(FINISHED_RUN.run.runId, 'slow/0/start')
    const step = db.steps.get(key)!
    db.steps.set(key, {
      ...step,
      outputs: { ...(step.outputs as Record<string, unknown>), report: { $file: stepRef } },
    })

    const run = db.runs.get(FINISHED_RUN.run.runId)!
    db.runs.set(run.runId, { ...run, outputs: { ...run.outputs, lines: { $file: runRef } } })
  }

  it('replaces a step row’s pointer with the JSON it points to', async () => {
    offload()

    const res = await store().dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId))

    const slow = outputsOf(res.data!.steps.find((s) => s.key === 'slow/0/start')!)
    expect(slow.report).toBe(REPORT)
    // Every other output of the same row is untouched.
    expect(slow.poster).toEqual(outputsOf(FINISHED_RUN.steps.find((s) => s.key === 'slow/0/start')!).poster)
  })

  it('replaces the run row’s own pointer too', async () => {
    offload()

    const res = await store().dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId))

    expect(res.data!.run!.outputs?.lines).toEqual(LINES)
    expect(res.data!.run!.outputs?.report).toBe(FINISHED_RUN.run.outputs!.report)
  })

  it('leaves an unreadable payload as a { $file, $error } sentinel rather than failing the query', async () => {
    offload()
    server.use(http.get('/api/uploads/*', () => new HttpResponse(null, { status: 500 })))

    const res = await store().dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId))

    expect(res.error).toBeUndefined()
    const slow = outputsOf(res.data!.steps.find((s) => s.key === 'slow/0/start')!)
    expect(slow.report).toMatchObject({
      $file: expect.objectContaining({ path: 'workflows/hello/hello/runs/x/slow/0/start/report.json' }),
      $error: expect.stringContaining('500'),
    })
  })

  it('reads an offloaded payload from the bucket once across repeated reads of the same run (apps#375)', async () => {
    offload()
    let uploads = 0
    server.use(
      http.get('/api/uploads/*', ({ request }) => {
        uploads += 1
        const path = new URL(request.url).pathname.replace('/api/uploads/', '')
        const file = db.files.get(path)
        return file ? HttpResponse.arrayBuffer(file.bytes.buffer as ArrayBuffer, { headers: { 'content-type': file.contentType } }) : new HttpResponse(null, { status: 404 })
      }),
    )
    const s = store()

    // The 5 s poll: a second read of the same run, with the cache entry for the first still live.
    await s.dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId, { forceRefetch: true }))
    await s.dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId, { forceRefetch: true }))
    expect(uploads).toBe(2) // one per offloaded output (step + run), not per read

    // A different run wipes the memo, so the next read of the first run fetches again.
    await s.dispatch(workflowApi.endpoints.getRun.initiate('run_other'))
    await s.dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId, { forceRefetch: true }))
    expect(uploads).toBe(4)
  })

  it('reads a record with no offloaded outputs without touching the bucket', async () => {
    let uploads = 0
    server.use(
      http.get('/api/uploads/*', () => {
        uploads += 1
        return new HttpResponse(null, { status: 404 })
      }),
    )

    const res = await store().dispatch(workflowApi.endpoints.getRun.initiate(FINISHED_RUN.run.runId))

    expect(uploads).toBe(0)
    expect(res.data?.steps).toHaveLength(6)
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
