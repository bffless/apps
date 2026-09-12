/**
 * `fetchPayload` (Task 13): the read path's `{"$file"}` fetcher. It must never
 * reject — every failure becomes the `{ $file, $error }` sentinel `ValueView`
 * renders as a "payload unavailable" chip — and, since the ref comes off a run
 * row any authenticated member can write, it must only ever GET the harness's
 * own file-serve route (the final whole-branch review's minor).
 */
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '../mocks/server'
import { fetchPayload, fetchPayloadCached, forgetPayloads } from './payloadFetch'
import { SCOPE_HEADER, writeScope } from './scope'
import type { FileRef } from './runner/types'

const ref = (url: string): FileRef => ({
  path: 'workflows/hello/hello/runs/run_1/big.json',
  name: 'big.json',
  contentType: 'application/json',
  size: 4,
  url,
})

const PAYLOAD_URL = '/api/uploads/workflows/hello/hello/runs/run_1/big.json'

afterEach(() => {
  vi.restoreAllMocks()
  writeScope('mine')
})

describe('fetchPayload', () => {
  it('returns the parsed payload', async () => {
    server.use(http.get(PAYLOAD_URL, () => HttpResponse.json({ n: 1 })))
    await expect(fetchPayload(ref(PAYLOAD_URL))).resolves.toEqual({ n: 1 })
  })

  it('answers the sentinel for a non-2xx status', async () => {
    server.use(http.get(PAYLOAD_URL, () => new HttpResponse(null, { status: 404 })))
    const value = ref(PAYLOAD_URL)
    await expect(fetchPayload(value)).resolves.toEqual({ $file: value, $error: 'the payload request answered 404' })
  })

  it('drains the body of a non-2xx answer, so the request completes rather than idling open', async () => {
    // A `Response` handed back without its body read leaves the request
    // in flight as far as the browser's network stack is concerned (the
    // 2026-09-12 `hello` walk: a 404 here held Playwright's `networkidle`
    // open for the full 30 s). The sentinel is the answer either way — the
    // body is read and dropped so the connection settles.
    const value = ref(PAYLOAD_URL)
    const res = new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res)
    await expect(fetchPayload(value)).resolves.toEqual({ $file: value, $error: 'the payload request answered 404' })
    expect(res.bodyUsed).toBe(true)
  })

  it('still answers the sentinel when the non-2xx body fails mid-read', async () => {
    // A truncated error envelope must not turn the drain into a rejection
    // that escapes into the memo (apps#685 review, Tests).
    const value = ref(PAYLOAD_URL)
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"err'))
        controller.error(new Error('stream reset'))
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(broken, { status: 502 }))
    await expect(fetchPayload(value)).resolves.toEqual({ $file: value, $error: 'the payload request answered 502' })
  })

  it('answers the sentinel when the fetch itself throws', async () => {
    server.use(http.get(PAYLOAD_URL, () => HttpResponse.error()))
    const value = ref(PAYLOAD_URL)
    const result = (await fetchPayload(value)) as { $file: FileRef; $error: string }
    expect(result.$file).toEqual(value)
    expect(typeof result.$error).toBe('string')
    expect(result.$error).not.toBe('')
  })

  it('answers the sentinel when the body is not JSON', async () => {
    server.use(http.get(PAYLOAD_URL, () => new HttpResponse('<!doctype html>', { status: 200 })))
    const value = ref(PAYLOAD_URL)
    const result = (await fetchPayload(value)) as { $file: FileRef; $error: string }
    expect(result.$file).toEqual(value)
    expect(typeof result.$error).toBe('string')
    expect(result.$error).not.toBe('')
  })

  /**
   * The serve route is gated by the same `runGate` every other run-scoped route
   * is (spec 11 D29), so the widened ask has to reach it or an owner/admin who
   * opened someone else's run reads a page of "payload unavailable" chips. It
   * is a `fetch`, so the header the rest of the SPA sends is available here —
   * and, since apps#665, `lib/scope.ts`'s `viewUrl` puts the same ask on the
   * url as well, the one channel a browser-built sink (an `<img src>`, a
   * download href) has. The ask is never on the ref itself: `coerce.ts`'s
   * `fileUrl` is pure, because a ref can be persisted.
   */
  it('sends the all-scope ask while the viewer has widened (D27)', async () => {
    writeScope('all')
    let sent: string | null = 'absent'
    server.use(
      http.get(PAYLOAD_URL, ({ request }) => {
        sent = request.headers.get(SCOPE_HEADER)
        return HttpResponse.json({ n: 1 })
      }),
    )

    await expect(fetchPayload(ref(PAYLOAD_URL))).resolves.toEqual({ n: 1 })
    expect(sent).toBe('all')
  })

  it('sends no ask while the viewer has not — never implicit (D27)', async () => {
    let sent: string | null = 'absent'
    server.use(
      http.get(PAYLOAD_URL, ({ request }) => {
        sent = request.headers.get(SCOPE_HEADER)
        return HttpResponse.json({ n: 1 })
      }),
    )

    await expect(fetchPayload(ref(PAYLOAD_URL))).resolves.toEqual({ n: 1 })
    expect(sent).toBeNull()
  })

  it('refuses a url outside the file-serve route without fetching it', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const value = ref('/api/workflow/run?id=1')
    await expect(fetchPayload(value)).resolves.toEqual({ $file: value, $error: 'url refused' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('refuses an off-site url without fetching it', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const value = ref('https://evil.example/api/uploads/x')
    await expect(fetchPayload(value)).resolves.toEqual({ $file: value, $error: 'url refused' })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('fetchPayloadCached', () => {
  it('answers a repeated read of the same path from memory', async () => {
    let hits = 0
    server.use(
      http.get(PAYLOAD_URL, () => {
        hits += 1
        return HttpResponse.json({ n: 1 })
      }),
    )
    await expect(fetchPayloadCached(ref(PAYLOAD_URL))).resolves.toEqual({ n: 1 })
    await expect(fetchPayloadCached(ref(PAYLOAD_URL))).resolves.toEqual({ n: 1 })
    expect(hits).toBe(1)
  })

  it('shares one in-flight request between concurrent reads of the same path', async () => {
    let hits = 0
    server.use(
      http.get(PAYLOAD_URL, () => {
        hits += 1
        return HttpResponse.json({ n: 1 })
      }),
    )
    const [a, b] = await Promise.all([fetchPayloadCached(ref(PAYLOAD_URL)), fetchPayloadCached(ref(PAYLOAD_URL))])
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 1 })
    expect(hits).toBe(1)
  })

  it('does not remember a failure — the next read tries the bucket again', async () => {
    let hits = 0
    server.use(
      http.get(PAYLOAD_URL, () => {
        hits += 1
        return hits === 1 ? new HttpResponse(null, { status: 404 }) : HttpResponse.json({ n: 2 })
      }),
    )
    const value = ref(PAYLOAD_URL)
    await expect(fetchPayloadCached(value)).resolves.toEqual({ $file: value, $error: 'the payload request answered 404' })
    await expect(fetchPayloadCached(value)).resolves.toEqual({ n: 2 })
  })

  it('forgets everything on forgetPayloads()', async () => {
    let hits = 0
    server.use(
      http.get(PAYLOAD_URL, () => {
        hits += 1
        return HttpResponse.json({ n: 1 })
      }),
    )
    await fetchPayloadCached(ref(PAYLOAD_URL))
    forgetPayloads()
    await fetchPayloadCached(ref(PAYLOAD_URL))
    expect(hits).toBe(2)
  })
})
