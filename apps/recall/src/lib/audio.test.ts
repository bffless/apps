import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { extractAudio } from './audio'

// jsdom has no WebAudio. Stub just enough of AudioContext/OfflineAudioContext
// for decodeToMono: decode reports a 2-second buffer, and the offline render
// returns a ramp of `frames` samples — so duration + WAV size are observable
// (44-byte header + 2 bytes per 16 kHz sample).
const RATE = 16000
const DURATION = 2

beforeEach(() => {
  vi.stubGlobal(
    'AudioContext',
    class {
      async decodeAudioData() {
        return { duration: DURATION }
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

describe('extractAudio', () => {
  it('decodes to a 16 kHz mono WAV and reports duration in seconds', async () => {
    const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' })
    const { wav, durationSec } = await extractAudio(file)

    expect(durationSec).toBe(DURATION)
    // 2 s at 16 kHz = 32000 samples = 44-byte header + 64000 bytes of PCM.
    expect(wav.size).toBe(44 + DURATION * RATE * 2)
    expect(wav.type).toBe('audio/wav')
  })

  it('resamples at the given target rate', async () => {
    const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' })
    const targetRate = 8000
    const { wav, durationSec } = await extractAudio(file, targetRate)

    expect(durationSec).toBe(DURATION)
    expect(wav.size).toBe(44 + DURATION * targetRate * 2)
  })
})
