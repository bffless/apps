import { describe, it, expect } from 'vitest'
import { buildSliceCommand } from './slice'

/** Pull the value following `flag` in an argv (e.g. the `-ss` seek time). */
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('buildSliceCommand', () => {
  it('fast-seeks to start and stops at end (re-encode, clean from t=0)', () => {
    const { args } = buildSliceCommand({ start: 104, end: 228 })
    // -ss BEFORE -i (fast seek); -copyts keeps the demuxer's absolute timestamps
    // so the trim filter below can address original-video seconds.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(argAfter(args, '-ss')).toBe('104')
    expect(args).toContain('-copyts')
    // -to is an ABSOLUTE source second under -copyts (not a duration), and an
    // output option, so it must sit after -i.
    expect(argAfter(args, '-to')).toBe('228')
    expect(args.indexOf('-to')).toBeGreaterThan(args.indexOf('-i'))
    // Re-encode (not stream-copy) so timestamps reset to 0 and A/V stay aligned.
    expect(argAfter(args, '-c:v')).toBe('libx264')
    expect(args).not.toContain('copy')
  })

  it('rebases video and audio to the SAME origin (lip sync)', () => {
    // Plain `-ss` snaps video to the next whole frame but audio to the exact
    // sample, then zeroes both — so the clip's picture leads its sound by up to
    // 1/fps. Trimming in the filter graph against a shared origin keeps the
    // first frame's sub-frame offset intact.
    const { args } = buildSliceCommand({ start: 3.017, end: 7.017 })
    const fc = argAfter(args, '-filter_complex')
    expect(fc).toContain('[0:v]trim=3.017:7.017,setpts=PTS-3.017/TB[v]')
    expect(fc).toContain('[0:a]atrim=3.017:7.017,asetpts=PTS-3.017/TB[a]')
    expect(fc).not.toContain('STARTPTS')
    expect(args).toContain('[v]')
    expect(args).toContain('[a]')
  })

  it('pins the output frame rate to the source (no silent 25fps resample)', () => {
    const { args } = buildSliceCommand({ start: 0, end: 10 })
    expect(argAfter(args, '-fps_mode')).toBe('passthrough')
    expect(args).not.toContain('-r')
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
    expect(argAfter(args, '-to')).toBe('3')
  })

  it('clamps a negative start to zero', () => {
    const { args } = buildSliceCommand({ start: -5, end: 10 })
    expect(argAfter(args, '-ss')).toBe('0')
    expect(argAfter(args, '-to')).toBe('10')
  })

  it('never emits a negative/zero span when end ≤ start', () => {
    const { args } = buildSliceCommand({ start: 50, end: 40 })
    expect(argAfter(args, '-ss')).toBe('50')
    expect(argAfter(args, '-to')).toBe('50')
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
