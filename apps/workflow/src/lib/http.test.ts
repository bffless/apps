/**
 * `httpJson` is the `HttpJson` the pipeline adapter (03) is written against, so
 * these tests pin the contract the adapter relies on: query building, JSON in,
 * and JSON-or-text out.
 */
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { httpJson, httpJsonWithReauth, toQueryString } from './http'

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
