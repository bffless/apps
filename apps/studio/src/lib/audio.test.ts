import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sliceManyAudioWav } from './audio'

// jsdom has no WebAudio. Stub just enough of AudioContext/OfflineAudioContext
// for decodeToMono: decode reports a 1-second buffer, and the offline render
// returns a ramp of `frames` samples — so span math is observable via WAV size
// (44-byte header + 2 bytes per 16 kHz sample).
const RATE = 16000

beforeEach(() => {
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData() {
        return { duration: 1 }
      }
      close() {}
    },
  )
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      frames: number
      constructor(_channels: number, frames: number) {
        this.frames = frames
      }
      destination = {}
      createBufferSource() {
        return { buffer: null, connect: () => {}, start: () => {} }
      }
      async startRendering() {
        const data = new Float32Array(this.frames)
        return { getChannelData: () => data }
      }
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sliceManyAudioWav', () => {
  it('accepts a prefetched Blob and never fetches', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const blobs = await sliceManyAudioWav(new Blob(['wav-bytes']), [
      { start: 0.25, end: 0.5 },
      { start: 0, end: 1 },
    ])

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(blobs).toHaveLength(2)
    // [0.25, 0.5] of a 1 s clip at 16 kHz = 4000 samples = 44 + 8000 bytes.
    expect(blobs[0].size).toBe(44 + 0.25 * RATE * 2)
    expect(blobs[1].size).toBe(44 + 1 * RATE * 2)
  })

  it('still fetches when given a URL', async () => {
    // A minimal response stand-in: jsdom Blobs can't body an undici Response.
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['wav-bytes']) }))
    vi.stubGlobal('fetch', fetchSpy)

    const blobs = await sliceManyAudioWav('/api/uploads/serve/audio.wav', [{ start: 0, end: 0.5 }])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(blobs).toHaveLength(1)
    expect(blobs[0].size).toBe(44 + 0.5 * RATE * 2)
  })
})
