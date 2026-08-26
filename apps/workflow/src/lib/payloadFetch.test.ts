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
