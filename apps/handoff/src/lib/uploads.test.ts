import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  beginUpload,
  setUploadProgress,
  completeUpload,
  failUpload,
  cancelUpload,
  isUploadCanceled,
  registerAbort,
  dismissUpload,
  clearFinishedUploads,
  getUploads,
  subscribeUploads,
  resetUploadsForTest,
  DONE_DISMISS_MS,
} from './uploads'

describe('uploads store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetUploadsForTest()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('makes an entry visible immediately, before any bytes move', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    const [item] = getUploads()
    expect(item.id).toBe(id)
    expect(item.name).toBe('demo.mp4')
    expect(item.size).toBe(300)
    expect(item.loaded).toBe(0)
    expect(item.status).toBe('queued')
  })

  it('flips to uploading and tracks loaded bytes on progress', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    setUploadProgress(id, 204)
    const [item] = getUploads()
    expect(item.status).toBe('uploading')
    expect(item.loaded).toBe(204)
  })

  it('clamps loaded to the known size', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    setUploadProgress(id, 900)
    expect(getUploads()[0].loaded).toBe(300)
  })

  it('marks done and auto-dismisses after the grace period', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    completeUpload(id)
    expect(getUploads()[0].status).toBe('done')
    expect(getUploads()[0].loaded).toBe(300)

    vi.advanceTimersByTime(DONE_DISMISS_MS - 1)
    expect(getUploads()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(getUploads()).toHaveLength(0)
  })

  it('keeps failures until they are dismissed', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    failUpload(id, 'Bucket upload failed (500)')
    vi.advanceTimersByTime(DONE_DISMISS_MS * 10)
    const [item] = getUploads()
    expect(item.status).toBe('error')
    expect(item.error).toBe('Bucket upload failed (500)')

    dismissUpload(id)
    expect(getUploads()).toHaveLength(0)
  })

  it('cancel runs the registered abort and marks the entry canceled', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    const abort = vi.fn()
    registerAbort(id, abort)
    setUploadProgress(id, 100)

    cancelUpload(id)

    expect(abort).toHaveBeenCalledTimes(1)
    expect(getUploads()[0].status).toBe('canceled')
  })

  it('auto-dismisses a canceled entry like a completed one', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    cancelUpload(id)
    vi.advanceTimersByTime(DONE_DISMISS_MS)
    expect(getUploads()).toHaveLength(0)
  })

  it('remembers a cancellation after the entry is gone, so callers can stay quiet', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    const other = beginUpload({ name: 'keep.png', size: 1 })
    expect(isUploadCanceled(id)).toBe(false)

    cancelUpload(id)
    expect(isUploadCanceled(id)).toBe(true)

    vi.advanceTimersByTime(DONE_DISMISS_MS)
    expect(getUploads().map((u) => u.id)).toEqual([other])
    expect(isUploadCanceled(id)).toBe(true)
  })

  it('ignores progress and completion after cancel', () => {
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    cancelUpload(id)
    setUploadProgress(id, 200)
    completeUpload(id)
    expect(getUploads()[0].status).toBe('canceled')
  })

  it('ignores updates for an unknown id', () => {
    expect(() => setUploadProgress('nope', 1)).not.toThrow()
    expect(() => completeUpload('nope')).not.toThrow()
    expect(() => cancelUpload('nope')).not.toThrow()
    expect(getUploads()).toHaveLength(0)
  })

  it('tracks a multi-file group as one entry with a file counter', () => {
    const id = beginUpload({ name: 'my-site', size: 0, fileCount: 40 })
    setUploadProgress(id, 0, { fileIndex: 12, size: 1000 })
    const [item] = getUploads()
    expect(item.fileCount).toBe(40)
    expect(item.fileIndex).toBe(12)
    expect(item.size).toBe(1000)
  })

  it('notifies subscribers on every transition and stops after unsubscribe', () => {
    const seen = vi.fn()
    const unsubscribe = subscribeUploads(seen)
    const id = beginUpload({ name: 'demo.mp4', size: 300 })
    setUploadProgress(id, 10)
    completeUpload(id)
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(3)

    unsubscribe()
    const before = seen.mock.calls.length
    beginUpload({ name: 'other.png', size: 5 })
    expect(seen.mock.calls.length).toBe(before)
  })

  it('returns a stable snapshot identity between changes', () => {
    beginUpload({ name: 'demo.mp4', size: 300 })
    expect(getUploads()).toBe(getUploads())
  })

  it('preserves insertion order across many entries', () => {
    beginUpload({ name: 'a.png', size: 1 })
    beginUpload({ name: 'b.png', size: 1 })
    beginUpload({ name: 'c.png', size: 1 })
    expect(getUploads().map((u) => u.name)).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('clearFinishedUploads drops terminal entries but keeps live ones', () => {
    const live = beginUpload({ name: 'live.mp4', size: 300 })
    const done = beginUpload({ name: 'done.png', size: 1 })
    const bad = beginUpload({ name: 'bad.png', size: 1 })
    setUploadProgress(live, 5)
    completeUpload(done)
    failUpload(bad, 'nope')

    clearFinishedUploads()

    expect(getUploads().map((u) => u.name)).toEqual(['live.mp4'])
  })
})
