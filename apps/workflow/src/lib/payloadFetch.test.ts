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
import { fetchPayload } from './payloadFetch'
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
