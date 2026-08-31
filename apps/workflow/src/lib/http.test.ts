/**
 * `httpJson` is the `HttpJson` the pipeline adapter (03) is written against, so
 * these tests pin the contract the adapter relies on: query building, JSON in,
 * and JSON-or-text out.
 */
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { httpJson, httpJsonWithReauth, toQueryString } from './http'
import { createRunStore } from './runStore'

describe('toQueryString', () => {
  it('skips undefined and null, and JSON-stringifies non-primitives', () => {
    expect(toQueryString({ id: 'a', n: 1, ok: true, skip: undefined, none: null })).toBe(
      '?id=a&n=1&ok=true',
    )
    expect(toQueryString({ where: { a: 1 } })).toBe('?where=%7B%22a%22%3A1%7D')
    expect(toQueryString({})).toBe('')
    expect(toQueryString()).toBe('')
  })
})

describe('httpJson', () => {
  it('sends a JSON body with a content-type and parses the JSON answer', async () => {
    let seen: { contentType: string | null; body: unknown } | null = null
    server.use(
      http.post('/api/test/echo', async ({ request }) => {
        seen = { contentType: request.headers.get('content-type'), body: await request.json() }
        return HttpResponse.json({ ok: true })
      }),
    )

    const res = await httpJson('/api/test/echo', { method: 'POST', body: { text: 'hi' } })

    expect(res).toEqual({ status: 200, ok: true, body: { ok: true } })
    expect(seen).toEqual({ contentType: 'application/json', body: { text: 'hi' } })
  })

  it('appends the query string and sends no body on GET', async () => {
    let url = ''
    server.use(
      http.get('/api/test/job', ({ request }) => {
        url = new URL(request.url).search
        return HttpResponse.json({ status: 'done' })
      }),
    )

    const res = await httpJson('/api/test/job', { method: 'GET', query: { id: 'job_1', skip: undefined } })

    expect(url).toBe('?id=job_1')
    expect(res.body).toEqual({ status: 'done' })
  })

  it('returns a non-JSON body as the raw text the adapter expects', async () => {
    server.use(http.get('/api/test/text', () => HttpResponse.text('plain words')))

    const res = await httpJson('/api/test/text', { method: 'GET' })

    expect(res.body).toBe('plain words')
  })

  it('reports a non-2xx without throwing', async () => {
    server.use(http.post('/api/test/fail', () => HttpResponse.json({ code: 'TEAPOT' }, { status: 418 })))

    const res = await httpJson('/api/test/fail', { method: 'POST', body: {} })

    expect(res).toEqual({ status: 418, ok: false, body: { code: 'TEAPOT' } })
  })

  // apps#528: CE names the execution log it wrote in `X-Pipeline-Log-Id` —
  // on debug-enabled rules, and on every execution failure with debug off.
  it('captures X-Pipeline-Log-Id as logId, on success and on failure', async () => {
    server.use(
      http.get('/api/test/logged', () =>
        HttpResponse.json({ ok: true }, { headers: { 'x-pipeline-log-id': 'plog_1' } }),
      ),
      http.get('/api/test/logged-fail', () =>
        HttpResponse.json(
          { code: 'BOOM' },
          { status: 500, headers: { 'x-pipeline-log-id': 'plog_2' } },
        ),
      ),
    )

    expect((await httpJson('/api/test/logged', { method: 'GET' })).logId).toBe('plog_1')
    expect((await httpJson('/api/test/logged-fail', { method: 'GET' })).logId).toBe('plog_2')
  })

  it('leaves logId absent — not null — when the response carries no header', async () => {
    server.use(http.get('/api/test/unlogged', () => HttpResponse.json({ ok: true })))

    const res = await httpJson('/api/test/unlogged', { method: 'GET' })

    expect('logId' in res).toBe(false)
  })
})

describe('httpJsonWithReauth', () => {
  it('refreshes the session once on a 401 and retries the request', async () => {
    let refreshes = 0
    server.use(
      http.get('/api/test/secure', () => new HttpResponse(null, { status: 401 }), { once: true }),
      http.get('/api/test/secure', () => HttpResponse.json({ ok: true })),
      http.post('/api/auth/session/refresh', () => {
        refreshes += 1
        return new HttpResponse(null, { status: 200 })
      }),
    )

    const res = await httpJsonWithReauth('/api/test/secure', { method: 'GET' })

    expect(refreshes).toBe(1)
    expect(res).toEqual({ status: 200, ok: true, body: { ok: true } })
  })

  it('returns the original 401 when the refresh itself fails', async () => {
    server.use(
      http.get('/api/test/secure-fail', () => new HttpResponse(null, { status: 401 })),
      http.post('/api/auth/session/refresh', () => new HttpResponse(null, { status: 401 })),
    )

    const res = await httpJsonWithReauth('/api/test/secure-fail', { method: 'GET' })

    expect(res.status).toBe(401)
    expect(res.ok).toBe(false)
  })

  it('shares one refresh call across two concurrent 401s (refreshInFlight)', async () => {
    let calls = 0
    let refreshes = 0
    server.use(
      http.get('/api/test/secure-concurrent', () => {
        calls += 1
        return calls <= 2 ? new HttpResponse(null, { status: 401 }) : HttpResponse.json({ ok: true })
      }),
      http.post('/api/auth/session/refresh', () => {
        refreshes += 1
        return new HttpResponse(null, { status: 200 })
      }),
    )

    const [a, b] = await Promise.all([
      httpJsonWithReauth('/api/test/secure-concurrent', { method: 'GET' }),
      httpJsonWithReauth('/api/test/secure-concurrent', { method: 'GET' }),
    ])

    expect(refreshes).toBe(1)
    expect(a).toEqual({ status: 200, ok: true, body: { ok: true } })
    expect(b).toEqual({ status: 200, ok: true, body: { ok: true } })
  })
})

// ---------------------------------------------------------------------------
// `runStore` shares this module's `HttpJson`, and its one *interactive* call —
// delete — needs more than "it failed": the header (Task 20) distinguishes a
// 403 (not yours) from a 409 (still running), so the rejection carries the
// status. Tested here because `runStore` has no suite of its own.
// ---------------------------------------------------------------------------

describe('runStore.deleteRun', () => {
  it('posts the id and reads back both sweep counts', async () => {
    let seen: unknown = null
    server.use(
      http.post('/api/workflow/run/delete', async ({ request }) => {
        seen = await request.json()
        // Deliberately different numbers: the objects removed from storage and the
        // upload rows removed are two separate sweeps, and must not be conflated.
        return HttpResponse.json({ ok: true, deleted: { files: 3, records: 5 } })
      }),
    )

    await expect(createRunStore(httpJson).deleteRun('run_1')).resolves.toEqual({ files: 3, records: 5 })
    expect(seen).toEqual({ id: 'run_1' })
  })

  it('reads a missing count as 0 rather than undefined', async () => {
    server.use(http.post('/api/workflow/run/delete', () => HttpResponse.json({ ok: true })))

    await expect(createRunStore(httpJson).deleteRun('run_1')).resolves.toEqual({ files: 0, records: 0 })
  })

  it('rejects carrying the refusal status, so 403 and 409 stay tellable apart', async () => {
    server.use(
      http.post('/api/workflow/run/delete', () =>
        HttpResponse.json({ ok: false, error: 'cancel the run first' }, { status: 409 }),
      ),
    )

    await expect(createRunStore(httpJson).deleteRun('run_1')).rejects.toMatchObject({ status: 409 })
  })
})

// ---------------------------------------------------------------------------
// `keepalive` (run_01M1AH1SE9ZKKK3B29QE0BYFZE post-mortem): a same-tab
// navigation right after the "Succeeded" pill killed the in-flight
// `run/update` that seals the record, leaving it `running` with a live-looking
// lease forever. The sealing write asks for `keepalive` so the browser
// finishes it after the page is gone. MSW cannot see the flag, so these spy on
// `fetch` itself.
// ---------------------------------------------------------------------------

describe('httpJson keepalive', () => {
  function spyFetch(): { init: () => RequestInit | undefined; restore: () => void } {
    const original = globalThis.fetch
    let seen: RequestInit | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    return { init: () => seen, restore: () => (globalThis.fetch = original) }
  }

  it('threads keepalive to fetch when asked and the body fits the budget', async () => {
    const spy = spyFetch()
    try {
      await httpJson('/api/test/seal', { method: 'POST', body: { id: 'run_1' }, keepalive: true })
      expect(spy.init()?.keepalive).toBe(true)
    } finally {
      spy.restore()
    }
  })

  it('degrades to an ordinary fetch when the body exceeds the keepalive budget', async () => {
    const spy = spyFetch()
    try {
      // Chrome rejects a keepalive fetch whose body blows the 64 KB in-flight
      // budget — degrading must not fail the write, so the flag is dropped.
      const big = 'x'.repeat(70 * 1024)
      await httpJson('/api/test/seal', { method: 'POST', body: { big }, keepalive: true })
      expect(spy.init()?.keepalive).toBeUndefined()
    } finally {
      spy.restore()
    }
  })

  it('sends no keepalive unless asked', async () => {
    const spy = spyFetch()
    try {
      await httpJson('/api/test/seal', { method: 'POST', body: { id: 'run_1' } })
      expect(spy.init()?.keepalive).toBeUndefined()
    } finally {
      spy.restore()
    }
  })
})

// The record-sealing write: `patchRun` is what turns a run row terminal
// (`run.finished` → status/outputs/finishedAt/lease-clear, rows.ts). It must
// ask for `keepalive`, or a tab that navigates the moment the pill flips
// leaves the record lying `running` with every step terminal.
describe('runStore.patchRun', () => {
  it('asks for keepalive on run/update, so navigation cannot kill the sealing write', async () => {
    let seen: { path: string; keepalive?: boolean } | null = null
    const fake: typeof httpJson = async (path, init) => {
      seen = { path, keepalive: (init as { keepalive?: boolean }).keepalive }
      return { status: 200, ok: true, body: { ok: true } }
    }

    await createRunStore(fake).patchRun('run_1', { status: 'succeeded' })

    expect(seen).toEqual({ path: '/api/workflow/run/update', keepalive: true })
  })
})
