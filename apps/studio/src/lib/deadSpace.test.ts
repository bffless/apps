import { describe, expect, it } from 'vitest'
import {
  DEAD_SLICE_SECONDS,
  DEFAULT_SILENCE_THRESHOLD,
  deadSpaceSpans,
  measureDeadSpace,
  noiseSpans,
  rmsPerSlice,
} from './deadSpace'

/** Mono PCM at `rate` Hz: one amplitude value per 0.1 s slice, held constant
 *  across the slice — so each slice's RMS IS that amplitude. */
function pcm(sliceAmplitudes: number[], rate = 100): Float32Array {
  const perSlice = Math.round(DEAD_SLICE_SECONDS * rate)
  const out = new Float32Array(sliceAmplitudes.length * perSlice)
  sliceAmplitudes.forEach((a, i) => out.fill(a, i * perSlice, (i + 1) * perSlice))
  return out
}

describe('rmsPerSlice', () => {
  it('measures one RMS value per 0.1s slice', () => {
    const rms = rmsPerSlice(pcm([0.5, 0, 0.2]), 100)
    expect(rms).toHaveLength(3)
    expect(rms[0]).toBeCloseTo(0.5)
    expect(rms[1]).toBe(0)
    expect(rms[2]).toBeCloseTo(0.2)
  })

  it('measures a partial trailing slice over its real samples, not zero-padded', () => {
    // 15 samples at 100 Hz = one full slice + a half slice, all at 0.4
    const samples = new Float32Array(15).fill(0.4)
    const rms = rmsPerSlice(samples, 100)
    expect(rms).toHaveLength(2)
    expect(rms[1]).toBeCloseTo(0.4) // padded-with-zeros would read ~0.28
  })

  it('returns nothing for empty audio', () => {
    expect(rmsPerSlice(new Float32Array(0), 100)).toEqual([])
  })
})

describe('deadSpaceSpans', () => {
  it('merges consecutive silent slices into one span on the slice lattice', () => {
    // loud ×2, silent ×4, loud ×2 → one span [0.2, 0.6]
    const rms = [0.2, 0.2, 0, 0, 0, 0, 0.2, 0.2]
    expect(deadSpaceSpans(rms)).toEqual([{ start: 0.2, end: 0.6 }])
  })

  it('drops silences shorter than the minimum — natural inter-word pauses', () => {
    // two silent slices = 0.2s < the 0.3s default minimum
    const rms = [0.2, 0, 0, 0.2]
    expect(deadSpaceSpans(rms)).toEqual([])
  })

  it('keeps a silence of exactly the minimum duration', () => {
    const rms = [0.2, 0, 0, 0, 0.2]
    expect(deadSpaceSpans(rms)).toEqual([{ start: 0.1, end: 0.4 }])
  })

  it('treats RMS at the threshold as sound, below it as silence', () => {
    const t = DEFAULT_SILENCE_THRESHOLD
    const rms = [t, t, t, t, t * 0.9, t * 0.9, t * 0.9, t * 0.9]
    expect(deadSpaceSpans(rms)).toEqual([{ start: 0.4, end: 0.8 }])
  })

  it('closes a span running to the end of the audio', () => {
    const rms = [0.2, 0, 0, 0, 0]
    expect(deadSpaceSpans(rms)).toEqual([{ start: 0.1, end: 0.5 }])
  })

  it('honours a custom threshold + minimum', () => {
    const rms = [0.2, 0.04, 0.04, 0.2]
    expect(deadSpaceSpans(rms, DEAD_SLICE_SECONDS, { threshold: 0.05, minSilenceSeconds: 0.2 })).toEqual([
      { start: 0.1, end: 0.3 },
    ])
  })
})

describe('measureDeadSpace', () => {
  it('finds the silent stretch in synthetic speech-pause-speech audio', () => {
    // 0.3s speech · 0.5s silence · 0.2s speech
    const samples = pcm([0.3, 0.3, 0.3, 0, 0, 0, 0, 0, 0.3, 0.3])
    expect(measureDeadSpace(samples, 100)).toEqual([{ start: 0.3, end: 0.8 }])
  })

  it('clamps a trailing span to the audio’s real length', () => {
    // 0.2s speech + 0.35s silence: the last slice is partial (0.05s), so the
    // lattice would run to 0.6 — the span must stop at the real 0.55.
    const rate = 100
    const samples = new Float32Array(55)
    samples.fill(0.3, 0, 20)
    expect(measureDeadSpace(samples, rate)).toEqual([{ start: 0.2, end: 0.55 }])
  })

  it('returns no spans for solid speech', () => {
    expect(measureDeadSpace(pcm([0.3, 0.3, 0.3, 0.3]), 100)).toEqual([])
  })
})

describe('noiseSpans', () => {
  const words = [
    { start: 0, end: 0.4 },
    { start: 2.0, end: 2.4 },
  ]

  it('is the timeline minus word spans minus dead space', () => {
    const dead = [{ start: 1.0, end: 2.0 }]
    expect(noiseSpans(words, dead, 3)).toEqual([
      { start: 0.4, end: 1.0 },
      { start: 2.4, end: 3 },
    ])
  })

  it('merges overlapping words and dead space before complementing', () => {
    // dead space overlaps the tail of a word — no sliver between them
    const dead = [{ start: 0.3, end: 1.0 }]
    expect(noiseSpans(words, dead, 2.4)).toEqual([{ start: 1.0, end: 2.0 }])
  })

  it('with no words and no dead space, the whole timeline is noise', () => {
    expect(noiseSpans([], [], 2)).toEqual([{ start: 0, end: 2 }])
  })

  it('fully covered timeline yields none', () => {
    expect(noiseSpans(words, [{ start: 0.4, end: 2.0 }], 2.4)).toEqual([])
  })

  it('ignores coverage past the end of the timeline', () => {
    expect(noiseSpans([], [{ start: 0.5, end: 9 }], 1)).toEqual([{ start: 0, end: 0.5 }])
  })

  it('returns nothing for a zero-length timeline', () => {
    expect(noiseSpans(words, [], 0)).toEqual([])
  })
})
