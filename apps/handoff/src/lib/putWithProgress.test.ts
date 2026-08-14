import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { putWithProgress, isAbortError } from './putWithProgress'

/**
 * Minimal XMLHttpRequest double. Real XHR is the only browser API that reports
 * *upload* progress (fetch cannot), so the helper is tested against a fake
 * rather than through MSW — the assertions here are about the event plumbing.
 */
class FakeXhr {
  static last: FakeXhr | null = null
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  status = 0
  aborted = false
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null

  constructor() {
    FakeXhr.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  // --- test helpers ---
  emitProgress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ lengthComputable, loaded, total })
  }
  finish(status: number) {
    this.status = status
    this.onload?.()
  }
}

const realXhr = globalThis.XMLHttpRequest

beforeEach(() => {
  FakeXhr.last = null
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
})
afterEach(() => {
  globalThis.XMLHttpRequest = realXhr
})

const blob = () => new Blob(['x'.repeat(10)])

describe('putWithProgress', () => {
  it('PUTs to the given url with the content type', async () => {
    const p = putWithProgress('https://bucket.example/key?sig=1', blob(), 'video/mp4')
    const xhr = FakeXhr.last!
    expect(xhr.method).toBe('PUT')
    expect(xhr.url).toBe('https://bucket.example/key?sig=1')
    expect(xhr.headers['Content-Type']).toBe('video/mp4')
    xhr.finish(200)
    await p
  })

  it('resolves ok for 2xx and not-ok (without throwing) for an error status', async () => {
    const okP = putWithProgress('u', blob(), 'text/plain')
    FakeXhr.last!.finish(204)
    expect(await okP).toEqual({ ok: true, status: 204 })

    const badP = putWithProgress('u', blob(), 'text/plain')
    FakeXhr.last!.finish(403)
    expect(await badP).toEqual({ ok: false, status: 403 })
  })

  it('forwards upload progress events to onProgress', async () => {
    const onProgress = vi.fn()
    const p = putWithProgress('u', blob(), 'text/plain', { onProgress })
    const xhr = FakeXhr.last!
    xhr.emitProgress(4, 10)
    xhr.emitProgress(10, 10)
    xhr.finish(200)
    await p
    expect(onProgress.mock.calls).toEqual([
      [4, 10],
      [10, 10],
    ])
  })

  it('skips progress events whose length is not computable', async () => {
    const onProgress = vi.fn()
    const p = putWithProgress('u', blob(), 'text/plain', { onProgress })
    const xhr = FakeXhr.last!
    xhr.emitProgress(4, 0, false)
    xhr.finish(200)
    await p
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('rejects with a network error when the transfer fails', async () => {
    const p = putWithProgress('u', blob(), 'text/plain')
    FakeXhr.last!.onerror?.()
    await expect(p).rejects.toThrow(/network/i)
  })

  it('aborts the request when the signal fires, and reports an abort error', async () => {
    const controller = new AbortController()
    const p = putWithProgress('u', blob(), 'text/plain', { signal: controller.signal })
    const xhr = FakeXhr.last!
    controller.abort()
    expect(xhr.aborted).toBe(true)
    await expect(p).rejects.toSatisfy(isAbortError)
  })

  it('never sends when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const p = putWithProgress('u', blob(), 'text/plain', { signal: controller.signal })
    await expect(p).rejects.toSatisfy(isAbortError)
    expect(FakeXhr.last).toBeNull()
  })

  it('isAbortError only matches abort errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false)
    expect(isAbortError('nope')).toBe(false)
  })
})
