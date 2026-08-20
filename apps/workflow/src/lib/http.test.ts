/**
 * `httpJson` is the `HttpJson` the pipeline adapter (03) is written against, so
 * these tests pin the contract the adapter relies on: query building, JSON in,
 * and JSON-or-text out.
 */
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { httpJson, toQueryString } from './http'

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
