import { describe, it, expect, vi, afterEach } from 'vitest'
import { captureFramesAt, FRAME_CAPTURE_STALL_MS } from './frames'

/**
 * captureFramesAt must never leave its promise unsettled: a detached <video>
 * can stall without firing `loadeddata`/`seeked`/`error`, and an unsettled
 * capture once froze the whole prep pipeline (the director job finished but
 * the scene commit hung awaiting card thumbs). jsdom never fires media
 * events, which makes it exactly the pathological video these tests need.
 */

/** Intercept the <video> element captureFramesAt creates so a test can fire
 *  media events on it. */
function trapVideo(): { get: () => HTMLVideoElement } {
  let video: HTMLVideoElement | null = null
  const orig = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = orig(tag)
    if (tag === 'video') video = el as HTMLVideoElement
    return el
  }) as typeof document.createElement)
  return {
    get: () => {
      if (!video) throw new Error('captureFramesAt created no <video>')
      return video
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('captureFramesAt (stall hardening)', () => {
  it('resolves [] immediately for an empty time list', async () => {
    await expect(captureFramesAt('blob:clip', [])).resolves.toEqual([])
  })

  it('resolves with nothing captured when the video never fires any event', async () => {
    vi.useFakeTimers()
    const p = captureFramesAt('blob:clip', [1, 2, 3])
    await vi.advanceTimersByTimeAsync(FRAME_CAPTURE_STALL_MS + 1)
    await expect(p).resolves.toEqual([])
  })

  it('resolves on a media error event', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    const p = captureFramesAt('blob:clip', [1])
    trap.get().dispatchEvent(new Event('error'))
    await expect(p).resolves.toEqual([])
  })

  it('load progress re-arms the watchdog; only true inactivity trips it', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    let settled = false
    const p = captureFramesAt('blob:clip', [1]).then((frames) => {
      settled = true
      return frames
    })

    // Two waits that each stay under the stall window, split by a progress
    // event — a big clip still downloading must not be cut off.
    await vi.advanceTimersByTimeAsync(FRAME_CAPTURE_STALL_MS - 1000)
    trap.get().dispatchEvent(new Event('progress'))
    await vi.advanceTimersByTimeAsync(FRAME_CAPTURE_STALL_MS - 1000)
    expect(settled).toBe(false)

    // ...but with no further progress the watchdog fires.
    await vi.advanceTimersByTimeAsync(1001)
    await expect(p).resolves.toEqual([])
    expect(settled).toBe(true)
  })
})
