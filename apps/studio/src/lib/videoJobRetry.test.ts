import { describe, expect, it, vi } from 'vitest'
import { BUSY_RETRY_DELAYS_MS, isTransientVideoJobError, withBusyRetry } from './videoJobRetry'

describe('isTransientVideoJobError', () => {
  it('matches CE’s FFMPEG_BUSY code wherever it appears in the job error', () => {
    expect(isTransientVideoJobError('Server slice failed (FFMPEG_BUSY: remote in-flight limit reached (8))')).toBe(true)
    expect(isTransientVideoJobError('FFMPEG_BUSY')).toBe(true)
  })
  it('does not match other failures', () => {
    expect(isTransientVideoJobError('Server slice failed')).toBe(false)
    expect(isTransientVideoJobError('Server slice failed (FFMPEG_EXECUTOR_UNAVAILABLE: …)')).toBe(false)
    expect(isTransientVideoJobError('')).toBe(false)
  })
})

describe('withBusyRetry', () => {
  const busy = () => new Error('Server slice failed (FFMPEG_BUSY: fuse)')

  it('returns the first successful attempt without sleeping', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(withBusyRetry(async () => 'ok', { sleep })).resolves.toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries busy failures with the 15s → 30s → 60s ladder, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const onRetry = vi.fn()
    const attempt = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue('ok')
    await expect(withBusyRetry(attempt, { sleep, onRetry })).resolves.toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([15_000, 30_000])
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, delayMs: 15_000 })
  })

  it('gives up after 4 attempts total and rethrows the last busy error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const attempt = vi.fn().mockRejectedValue(busy())
    await expect(withBusyRetry(attempt, { sleep })).rejects.toThrow(/FFMPEG_BUSY/)
    expect(attempt).toHaveBeenCalledTimes(BUSY_RETRY_DELAYS_MS.length + 1)
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([15_000, 30_000, 60_000])
  })

  it('rethrows a non-transient error immediately', async () => {
    const sleep = vi.fn()
    const attempt = vi.fn().mockRejectedValue(new Error('Server slice failed'))
    await expect(withBusyRetry(attempt, { sleep })).rejects.toThrow('Server slice failed')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('exports the locked ladder', () => {
    expect([...BUSY_RETRY_DELAYS_MS]).toEqual([15_000, 30_000, 60_000])
  })
})
