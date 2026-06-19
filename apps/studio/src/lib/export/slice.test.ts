import { describe, it, expect } from 'vitest'
import { buildSliceCommand } from './slice'

/** Pull the value following `flag` in an argv (e.g. the `-ss` seek time). */
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('buildSliceCommand', () => {
  it('seeks to start and trims for the span length (re-encode, clean from t=0)', () => {
    const { args } = buildSliceCommand({ start: 104, end: 228 })
    // -ss BEFORE -i (fast seek), then -t = end - start.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(argAfter(args, '-ss')).toBe('104')
    expect(argAfter(args, '-t')).toBe('124')
    // Re-encode (not stream-copy) so timestamps reset to 0 and A/V stay aligned.
    expect(argAfter(args, '-c:v')).toBe('libx264')
    expect(args).not.toContain('copy')
  })

  it('defaults the source/output names and echoes them back', () => {
    const cmd = buildSliceCommand({ start: 0, end: 10 })
    expect(cmd.source).toBe('source.mp4')
    expect(cmd.output).toBe('clip.mp4')
    expect(cmd.args[cmd.args.length - 1]).toBe('clip.mp4')
    expect(argAfter(cmd.args, '-i')).toBe('source.mp4')
  })

  it('honors explicit source/output names', () => {
    const cmd = buildSliceCommand({ start: 1, end: 2, source: 'raw.mov', output: 'scene1.mp4' })
    expect(argAfter(cmd.args, '-i')).toBe('raw.mov')
    expect(cmd.args[cmd.args.length - 1]).toBe('scene1.mp4')
  })

  it('trims trailing zeros off fractional seconds', () => {
    const { args } = buildSliceCommand({ start: 1.5, end: 3 })
    expect(argAfter(args, '-ss')).toBe('1.5')
    expect(argAfter(args, '-t')).toBe('1.5')
  })

  it('clamps a negative start to zero', () => {
    const { args } = buildSliceCommand({ start: -5, end: 10 })
    expect(argAfter(args, '-ss')).toBe('0')
    expect(argAfter(args, '-t')).toBe('10')
  })

  it('never emits a negative/zero duration when end ≤ start', () => {
    const { args } = buildSliceCommand({ start: 50, end: 40 })
    expect(argAfter(args, '-ss')).toBe('50')
    expect(argAfter(args, '-t')).toBe('0')
  })

  it('caps the encoder at 4 threads (bounds x264 init memory in the fixed wasm heap)', () => {
    const { args } = buildSliceCommand({ start: 0, end: 10 })
    const i = args.indexOf('-threads')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('4')
    // An output option: after the input, before the output filename.
    expect(i).toBeGreaterThan(args.indexOf('-i'))
    expect(i).toBeLessThan(args.length - 1)
  })
})
