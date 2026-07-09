import { describe, it, expect } from 'vitest'
import {
  planAssembly,
  planScene,
  buildFfmpegCommand,
  buildConcatCommand,
  type AssemblePlan,
} from './assemble'

describe('planAssembly', () => {
  it('keeps the whole clip when there are no cuts', () => {
    const plan = planAssembly({ cuts: [], duration: 10 })
    expect(plan.video).toEqual([{ start: 0, end: 10 }])
    expect(plan.duration).toBe(10)
  })

  it('drops the cut spans and keeps the rest, in order', () => {
    const plan = planAssembly({ cuts: [{ start: 2, end: 4 }, { start: 7, end: 8 }], duration: 10 })
    expect(plan.video).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 7 },
      { start: 8, end: 10 },
    ])
    expect(plan.duration).toBeCloseTo(7, 5)
  })

  it('merges overlapping/touching cuts before walking', () => {
    const plan = planAssembly({
      cuts: [{ start: 1, end: 3 }, { start: 2.5, end: 5 }, { start: 5, end: 6 }],
      duration: 10,
    })
    expect(plan.video).toEqual([
      { start: 0, end: 1 },
      { start: 6, end: 10 },
    ])
  })

  it('clamps cuts to the clip and ignores empty ones', () => {
    const plan = planAssembly({
      cuts: [{ start: -5, end: 2 }, { start: 9, end: 20 }, { start: 4, end: 4 }],
      duration: 10,
    })
    expect(plan.video).toEqual([{ start: 2, end: 9 }])
  })

  it('honors trailing footage past the last cut (kept, not trimmed)', () => {
    const plan = planAssembly({ cuts: [{ start: 5, end: 6 }], duration: 10 })
    expect(plan.video[plan.video.length - 1]).toEqual({ start: 6, end: 10 })
  })

  it('returns an empty plan when everything is cut / duration is invalid', () => {
    expect(planAssembly({ cuts: [{ start: 0, end: 10 }], duration: 10 }).video).toEqual([])
    expect(planAssembly({ cuts: [], duration: 0 }).video).toEqual([])
    expect(planAssembly({ cuts: [], duration: NaN }).video).toEqual([])
  })

  it('drops sub-EPS kept slivers between adjacent cuts', () => {
    const plan = planAssembly({
      cuts: [{ start: 0, end: 5 }, { start: 5.0005, end: 10 }],
      duration: 10,
    })
    expect(plan.video).toEqual([])
  })
})

describe('planScene', () => {
  it('rebases original-video cuts into clip-local time', () => {
    // Scene [100, 160]; cut 120–130 → clip-local 20–30 on a 60s clip.
    const plan = planScene({ cuts: [{ start: 120, end: 130 }], start: 100, end: 160 })
    expect(plan.video).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
    ])
    expect(plan.duration).toBeCloseTo(50, 5)
  })

  it('clamps cuts that spill outside the scene window', () => {
    const plan = planScene({ cuts: [{ start: 90, end: 110 }], start: 100, end: 160 })
    expect(plan.video).toEqual([{ start: 10, end: 60 }])
  })
})

describe('buildFfmpegCommand', () => {
  const plan: AssemblePlan = {
    video: [
      { start: 0, end: 2 },
      { start: 4, end: 7 },
    ],
    duration: 5,
  }

  it('trims video AND audio from the source with the same spans', () => {
    const cmd = buildFfmpegCommand(plan)
    expect(cmd.filterComplex).toContain('[0:v]trim=0:2,setpts=PTS-0/TB[v0]')
    expect(cmd.filterComplex).toContain('[0:v]trim=4:7,setpts=PTS-4/TB[v1]')
    expect(cmd.filterComplex).toContain('[0:a]atrim=0:2,asetpts=PTS-0/TB')
    expect(cmd.filterComplex).toContain('[0:a]atrim=4:7,asetpts=PTS-4/TB')
  })

  it('rebases each piece to the CUT boundary, never to STARTPTS (lip sync)', () => {
    // `trim` can only start on a whole frame, so the first surviving video frame
    // sits up to 1/fps AFTER the requested cut. `atrim` is sample-exact. Rebasing
    // each stream to its own first sample (PTS-STARTPTS) therefore throws that
    // sub-frame gap away on the video side only — the picture jumps ahead of the
    // sound by up to a frame at EVERY cut. Both streams must share one origin.
    const cmd = buildFfmpegCommand(plan)
    expect(cmd.filterComplex).not.toContain('STARTPTS')
    for (const piece of plan.video) {
      expect(cmd.filterComplex).toContain(`setpts=PTS-${piece.start}/TB`)
      expect(cmd.filterComplex).toContain(`asetpts=PTS-${piece.start}/TB`)
    }
  })

  it('pins the output frame rate to the source (no silent 25fps resample)', () => {
    // `setpts` clears the frame-rate on the filter link; with nothing to inherit,
    // ffmpeg falls back to its 25fps default and drops/dupes frames to match
    // (16% of a 30fps source, 58% of a 60fps one). `passthrough` keeps every frame
    // on its own timestamp.
    const cmd = buildFfmpegCommand(plan)
    const i = cmd.args.indexOf('-fps_mode')
    expect(i).toBeGreaterThan(-1)
    expect(cmd.args[i + 1]).toBe('passthrough')
    expect(cmd.args).not.toContain('-r')
  })

  it('concats both streams interleaved', () => {
    const cmd = buildFfmpegCommand(plan)
    expect(cmd.filterComplex).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]')
  })

  it('fades each piece audio edge (in at 0, out at its own end)', () => {
    const cmd = buildFfmpegCommand(plan)
    expect(cmd.filterComplex).toContain('afade=t=in:st=0:d=0.01')
    expect(cmd.filterComplex).toContain('afade=t=out:st=1.99:d=0.01') // 2s piece
    expect(cmd.filterComplex).toContain('afade=t=out:st=2.99:d=0.01') // 3s piece
  })

  it('skips the fades when audioPolish is off', () => {
    const cmd = buildFfmpegCommand(plan, { audioPolish: false })
    expect(cmd.filterComplex).not.toContain('afade')
  })

  it('has exactly one input (the source) and maps both outputs', () => {
    const cmd = buildFfmpegCommand(plan, { source: 'clip.mp4', output: 'scene.mp4' })
    expect(cmd.args.filter((a) => a === '-i')).toHaveLength(1)
    expect(cmd.args.slice(0, 2)).toEqual(['-i', 'clip.mp4'])
    expect(cmd.args).toContain('[vout]')
    expect(cmd.args).toContain('[aout]')
    expect(cmd.args[cmd.args.length - 1]).toBe('scene.mp4')
  })
})

describe('buildConcatCommand', () => {
  it('builds the stream-copy concat with a list file', () => {
    const cmd = buildConcatCommand(['scene-0.mp4', 'scene-1.mp4'])
    expect(cmd.listName).toBe('concat.txt')
    expect(cmd.listContent).toBe("file 'scene-0.mp4'\nfile 'scene-1.mp4'\n")
    expect(cmd.args).toContain('copy')
    expect(cmd.output).toBe('final.mp4')
  })
})
