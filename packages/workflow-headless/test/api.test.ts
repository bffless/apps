import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { pageApi } from '../src/api.js'
import { DriverError, EXIT } from '../src/errors.js'
import type { PageLike } from '../src/page.js'

/**
 * A page whose `evaluate` really runs the function it is handed, against a
 * stubbed global `fetch`. That is the only way to assert on what the in-page
 * half actually sends — the headers, the credentials mode, the bytes — which
 * is exactly where the bugs this suite guards live. Still no browser.
 */
interface Sent {
  url: string
  init: RequestInit & { headers: Record<string, string> }
}

const page = {
  async evaluate(fn: (arg: unknown) => unknown, arg: unknown) {
    return fn(arg)
  },
} as unknown as PageLike

let sent: Sent[]
let reply: (url: string) => unknown
const original = globalThis.fetch

beforeEach(() => {
  sent = []
  reply = () => ({
    status: 200,
    text: async () => '{"ok":true}',
    arrayBuffer: async () => new TextEncoder().encode('bytes').buffer,
  })
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init: init as Sent['init'] })
    const answer = reply(url)
    if (answer instanceof Error) throw answer
    return answer
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = original
})

const base = 'https://harness.test'

describe('the X-API-Key gate', () => {
  test('is added to a GET of /api/workflow/*', async () => {
    await pageApi(page, { base, token: 'k1' }).json('/api/workflow/run?id=run_1')
    expect(sent[0]!.init.headers['X-API-Key']).toBe('k1')
  })

  test('is NOT added to a write, even to /api/workflow/*', async () => {
    // A CE API key is pinned to role `user`; a POST carrying both a cookie and
    // a key can resolve to a different identity than the logged-in member.
    const api = pageApi(page, { base, token: 'k1' })
    await api.json('/api/workflow/files/prepare', { method: 'POST', body: { impl: 'hello' } })
    await api.json('/api/workflow/files/register', { method: 'POST', body: {} })
    expect(sent.map((s) => s.init.headers['X-API-Key'])).toEqual([undefined, undefined])
    expect(sent[0]!.init.headers['content-type']).toBe('application/json')
  })

  test('is NOT added outside /api/workflow/, and not at all without a token', async () => {
    await pageApi(page, { base, token: 'k1' }).text('/w/hello/.bffless/workflows/index.json')
    await pageApi(page, { base }).json('/api/workflow/run?id=run_1')
    expect(sent.map((s) => s.init.headers['X-API-Key'])).toEqual([undefined, undefined])
  })
})

describe('credentials mode', () => {
  test("the harness's own API is called with the session cookie", async () => {
    await pageApi(page, { base }).json('/api/workflow/runs')
    expect(sent[0]!.init.credentials).toBe('include')
    expect(sent[0]!.url).toBe('https://harness.test/api/workflow/runs')
  })

  test('the direct-to-bucket PUT is not — it mirrors the harness upload exactly', async () => {
    // `include` cross-origin needs Access-Control-Allow-Credentials on the
    // bucket, which S3/GCS CORS configs typically do not set: the PUT would be
    // blocked where the identical PUT from the UI succeeds.
    const bytes = new TextEncoder().encode('PNGDATA')
    const res = await pageApi(page, { base, token: 'k1' }).put(
      'https://bucket.test/workflows/a.png',
      bytes,
      'image/png',
    )
    expect(res).toEqual({ status: 200 })
    expect(sent[0]!.url).toBe('https://bucket.test/workflows/a.png')
    expect(sent[0]!.init.credentials).toBe('same-origin')
    expect(sent[0]!.init.headers).toEqual({ 'content-type': 'image/png' })
    expect(new Uint8Array(sent[0]!.init.body as ArrayBufferView['buffer'] & Uint8Array)).toEqual(bytes)
  })
})

describe('a request that never gets a response', () => {
  test('is a DriverError on the harness API — not a status a caller might soft-handle', async () => {
    reply = () => new TypeError('Failed to fetch')
    const error = await pageApi(page, { base })
      .json('/api/workflow/runs')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toMatch(/could not reach .*\/api\/workflow\/runs: Failed to fetch/)
  })

  test('is reported rather than thrown on the PUT, so the caller can diagnose CORS', async () => {
    reply = () => new TypeError('Failed to fetch')
    const res = await pageApi(page, { base }).put('https://bucket.test/x', new Uint8Array([1]), '')
    expect(res).toEqual({ status: 0, error: 'Failed to fetch' })
  })
})

describe('bytes', () => {
  test('survive the base64 round trip in both directions', async () => {
    const payload = new Uint8Array([0, 1, 2, 250, 255, 128])
    reply = () => ({
      status: 200,
      text: async () => '',
      arrayBuffer: async () => payload.buffer,
    })
    const res = await pageApi(page, { base }).bytes('/api/uploads/x')
    expect(res.status).toBe(200)
    expect(new Uint8Array(res.bytes)).toEqual(payload)
  })
})
