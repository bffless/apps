import { describe, it, expect } from 'vitest'
import {
  buildSlices,
  planAssembly,
  buildFfmpegCommand,
  buildMeasureCommand,
  parseLoudnorm,
  planScene,
  buildConcatCommand,
  type AssembleInput,
  type AssembleSegment,
} from './assemble'

/** A voiced segment (has an audio clip) over `[start, end]`. */
function seg(start: number, end: number, audioSeconds = end - start): AssembleSegment {
  return { start, end, audioUrl: `clip-${start}-${end}.wav`, audioSeconds }
}

const kinds = (input: AssembleInput) => buildSlices(input).map((s) => s.kind)

describe('buildSlices — the three-state walk', () => {
  it('single segment, no cuts: the whole span is one segment slice', () => {
    const slices = buildSlices({ segments: [seg(0, 10)], cuts: [], duration: 10 })
    expect(slices).toEqual([{ kind: 'segment', start: 0, end: 10, segmentIndex: 0 }])
  })

  it('dead space between two segments becomes a dead slice', () => {
    const slices = buildSlices({ segments: [seg(0, 4), seg(6, 10)], cuts: [], duration: 10 })
    expect(slices).toEqual([
      { kind: 'segment', start: 0, end: 4, segmentIndex: 0 },
      { kind: 'dead', start: 4, end: 6 },
      { kind: 'segment', start: 6, end: 10, segmentIndex: 1 },
    ])
  })

  it('cut wins on overlap: a cut inside a segment splits its kept video', () => {
    // segment 0–10, cut 5–8 → kept 0–5 and 8–10, both segment 0.
    const slices = buildSlices({ segments: [seg(0, 10)], cuts: [{ start: 5, end: 8 }], duration: 10 })
    expect(slices).toEqual([
      { kind: 'segment', start: 0, end: 5, segmentIndex: 0 },
      { kind: 'cut', start: 5, end: 8 },
      { kind: 'segment', start: 8, end: 10, segmentIndex: 0 },
    ])
  })

  it('a segment butting a cut: cut truncates the segment tail', () => {
    // segment 0–10, cut 8–12 (clamped to 10) → kept 0–8.
    const slices = buildSlices({ segments: [seg(0, 10)], cuts: [{ start: 8, end: 12 }], duration: 10 })
    expect(slices).toEqual([
      { kind: 'segment', start: 0, end: 8, segmentIndex: 0 },
      { kind: 'cut', start: 8, end: 10 },
    ])
  })

  it('trailing dead space past the last segment is kept (honored, not trimmed)', () => {
    // talk stops at 8 on a 10s clip → 8–10 is dead, not dropped.
    const slices = buildSlices({ segments: [seg(0, 8)], cuts: [], duration: 10 })
    expect(slices).toEqual([
      { kind: 'segment', start: 0, end: 8, segmentIndex: 0 },
      { kind: 'dead', start: 8, end: 10 },
    ])
  })

  it('N segments tile in order', () => {
    const input = { segments: [seg(0, 3), seg(3, 6), seg(6, 9)], cuts: [], duration: 9 }
    expect(kinds(input)).toEqual(['segment', 'segment', 'segment'])
    expect(buildSlices(input).map((s) => (s.kind === 'segment' ? s.segmentIndex : -1))).toEqual([0, 1, 2])
  })

  it('returns nothing for a non-positive duration', () => {
    expect(buildSlices({ segments: [seg(0, 5)], cuts: [], duration: 0 })).toEqual([])
  })
})

describe('planAssembly — video + audio pieces', () => {
  it('cut-split segment: two video trims but one audio clip covering both', () => {
    const plan = planAssembly({ segments: [seg(0, 10)], cuts: [{ start: 5, end: 8 }], duration: 10 })
    expect(plan.video).toEqual([
      { start: 0, end: 5 },
      { start: 8, end: 10 },
    ])
    // One clip for segment 0, length = kept video = 5 + 2 = 7. audioSeconds is
    // clamped to the slot (the 10s clip can't exceed its 7s of kept video).
    expect(plan.audio).toEqual([{ kind: 'clip', segmentIndex: 0, offset: 0, length: 7, audioSeconds: 7 }])
    expect(plan.duration).toBe(7)
  })

  it('a cut at the FRONT of a voiced segment offsets the clip to the kept tail', () => {
    // seg 2.37–8.73 voiced from its own original audio (6.36s); cut 2–5.5 drops the
    // front. Kept video is 5.5–8.73, so the clip must play from (5.5−2.37)=3.13s in
    // — NOT from 0, which would replay the cut-away opening over the later footage.
    const plan = planAssembly({
      segments: [seg(2.37, 8.73, 6.36)],
      cuts: [{ start: 2, end: 5.5 }],
      duration: 8.73,
    })
    // 0–2 is dead lead-in (before the cut and before speech), kept as silent video;
    // 5.5–8.73 is the kept segment footage.
    expect(plan.video).toEqual([
      { start: 0, end: 2 },
      { start: 5.5, end: 8.73 },
    ])
    expect(plan.audio).toHaveLength(2)
    expect(plan.audio[0]).toEqual({ kind: 'silence', length: 2 })
    const clip = plan.audio[1]
    expect(clip.kind).toBe('clip')
    if (clip.kind !== 'clip') throw new Error('expected a clip piece')
    expect(clip.segmentIndex).toBe(0)
    expect(clip.offset).toBeCloseTo(3.13, 6)
    expect(clip.length).toBeCloseTo(3.23, 6)
    expect(clip.audioSeconds).toBeCloseTo(3.23, 6)
  })

  it('a fully-kept segment has a zero clip offset', () => {
    const plan = planAssembly({ segments: [seg(0, 10)], cuts: [], duration: 10 })
    expect(plan.audio).toEqual([{ kind: 'clip', segmentIndex: 0, offset: 0, length: 10, audioSeconds: 10 }])
  })

  it('dead space → a silence piece of its own length', () => {
    const plan = planAssembly({ segments: [seg(0, 4), seg(6, 10)], cuts: [], duration: 10 })
    expect(plan.audio).toEqual([
      { kind: 'clip', segmentIndex: 0, offset: 0, length: 4, audioSeconds: 4 },
      { kind: 'silence', length: 2 },
      { kind: 'clip', segmentIndex: 1, offset: 0, length: 4, audioSeconds: 4 },
    ])
    // Video keeps everything (nothing cut), so duration == source duration.
    expect(plan.duration).toBe(10)
  })

  it('trailing dead space becomes trailing silence (kept video, no audio)', () => {
    const plan = planAssembly({ segments: [seg(0, 8)], cuts: [], duration: 10 })
    expect(plan.audio).toEqual([
      { kind: 'clip', segmentIndex: 0, offset: 0, length: 8, audioSeconds: 8 },
      { kind: 'silence', length: 2 },
    ])
  })

  it('an un-voiced segment (no audioUrl) plays as silence — no missing input', () => {
    const segments: AssembleSegment[] = [{ start: 0, end: 5 }] // no audioUrl
    const plan = planAssembly({ segments, cuts: [], duration: 5 })
    expect(plan.audio).toEqual([{ kind: 'silence', length: 5 }])
  })

  it('video and audio tracks are always equal total length', () => {
    const plan = planAssembly({
      segments: [seg(2.3, 5.8), seg(9, 13), seg(24, 43)],
      cuts: [
        { start: 0, end: 2.3 },
        { start: 5.8, end: 8.6 },
        { start: 13.5, end: 23.75 },
        { start: 37.1, end: 50 },
      ],
      duration: 53,
    })
    const vTotal = plan.video.reduce((n, v) => n + (v.end - v.start), 0)
    const aTotal = plan.audio.reduce((n, a) => n + a.length, 0)
    expect(aTotal).toBeCloseTo(vTotal, 6)
    expect(plan.duration).toBeCloseTo(vTotal, 6)
  })

  it("matches the story's worked example (source = 53s)", () => {
    // segments: [2.3–5.8] [9–13] [24–43] ; cuts: [0–2.3] [5.8–8.6] [13.5–23.75] [37.1–50]
    const plan = planAssembly({
      segments: [seg(2.3, 5.8), seg(9, 13), seg(24, 43)],
      cuts: [
        { start: 0, end: 2.3 },
        { start: 5.8, end: 8.6 },
        { start: 13.5, end: 23.75 },
        { start: 37.1, end: 50 },
      ],
      duration: 53,
    })
    // Kept footage, in order: seg0, dead 8.6–9, seg1, dead 13–13.5, dead 23.75–24,
    // seg2 (24–37.1, cut wins past 37.1), dead 50–53.
    expect(plan.video).toEqual([
      { start: 2.3, end: 5.8 },
      { start: 8.6, end: 9 },
      { start: 9, end: 13 },
      { start: 13, end: 13.5 },
      { start: 23.75, end: 24 },
      { start: 24, end: 37.1 },
      { start: 50, end: 53 },
    ])
    // Compare shape exactly but lengths with tolerance (float seconds arithmetic).
    const expected = [
      { kind: 'clip', segmentIndex: 0, length: 3.5 },
      { kind: 'silence', length: 0.4 },
      { kind: 'clip', segmentIndex: 1, length: 4 },
      { kind: 'silence', length: 0.5 },
      { kind: 'silence', length: 0.25 },
      { kind: 'clip', segmentIndex: 2, length: 37.1 - 24 },
      { kind: 'silence', length: 3 },
    ] as const
    expect(plan.audio).toHaveLength(expected.length)
    plan.audio.forEach((a, i) => {
      expect(a.kind).toBe(expected[i].kind)
      if (a.kind === 'clip') expect(a.segmentIndex).toBe((expected[i] as { segmentIndex: number }).segmentIndex)
      expect(a.length).toBeCloseTo(expected[i].length, 6)
    })
    expect(plan.duration).toBeCloseTo(53 - 2.3 - 2.8 - 10.25 - 12.9, 6) // source minus the four cuts
  })
})

describe('buildFfmpegCommand', () => {
  it('orders extra audio inputs by clip piece and references them in the graph', () => {
    const plan = planAssembly({ segments: [seg(0, 4), seg(6, 10)], cuts: [], duration: 10 })
    const cmd = buildFfmpegCommand(plan)
    // Two voiced segments → two extra inputs (a0.wav, a1.wav) after the source.
    expect(cmd.audioInputs).toEqual([0, 1])
    expect(cmd.args.slice(0, 6)).toEqual(['-i', 'source.mp4', '-i', 'a0.wav', '-i', 'a1.wav'])
    // The silence piece is generated, clips reference inputs 1 and 2 and are
    // polished (fades; loudnorm is disabled for now — see LOUDNORM_ENABLED).
    expect(cmd.filterComplex).toContain('anullsrc=r=48000:cl=mono,atrim=0:2')
    expect(cmd.filterComplex).toContain('[1:a]aresample=48000')
    expect(cmd.filterComplex).toContain('[2:a]aresample=48000')
    expect(cmd.filterComplex).not.toContain('loudnorm')
    expect(cmd.filterComplex).toContain('afade=t=in:st=0:d=0.01')
    expect(cmd.filterComplex).toContain('afade=t=out:st=')
    // Concats both tracks and maps them out.
    expect(cmd.filterComplex).toContain('concat=n=3:v=1:a=0[vout]')
    expect(cmd.filterComplex).toContain('concat=n=3:v=0:a=1[aout]')
    expect(cmd.args).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[aout]']))
  })

  it('seeks a front-cut clip to its offset so the kept tail audio plays', () => {
    const plan = planAssembly({
      segments: [seg(2.37, 8.73, 6.36)],
      cuts: [{ start: 2, end: 5.5 }],
      duration: 8.73,
    })
    const cmd = buildFfmpegCommand(plan)
    // The single clip (input 1) is trimmed from 3.13s into the clip, not from 0.
    expect(cmd.filterComplex).toMatch(/\[1:a\]aresample=48000[^[]*atrim=3\.13:6\.36/)
  })

  it('a fully-kept clip is not seeked (no leading atrim on the clip)', () => {
    const plan = planAssembly({ segments: [seg(0, 4)], cuts: [], duration: 4 })
    const cmd = buildFfmpegCommand(plan)
    // No offset → the clip graph goes straight from aformat into the fades, with
    // only the trailing slot atrim=0:4 (no leading atrim=<offset>:…).
    expect(cmd.filterComplex).toContain('aformat=sample_fmts=s16:channel_layouts=mono,afade=t=in')
  })

  it('audioPolish:false drops loudnorm + fades (raw concat)', () => {
    const plan = planAssembly({ segments: [seg(0, 4), seg(6, 10)], cuts: [], duration: 10 })
    const cmd = buildFfmpegCommand(plan, { audioPolish: false })
    expect(cmd.filterComplex).toContain('[1:a]aresample=48000')
    expect(cmd.filterComplex).not.toContain('loudnorm')
    expect(cmd.filterComplex).not.toContain('afade')
  })

  it('emits no extra audio inputs when nothing is voiced', () => {
    const plan = planAssembly({ segments: [{ start: 0, end: 5 }], cuts: [], duration: 5 })
    const cmd = buildFfmpegCommand(plan)
    expect(cmd.audioInputs).toEqual([])
    expect(cmd.args.filter((a) => a === '-i')).toHaveLength(1) // just the source
  })

  it('caps the encoder at 4 threads (bounds x264 init memory in the fixed wasm heap)', () => {
    const plan = planAssembly({ segments: [seg(0, 4)], cuts: [], duration: 4 })
    const { args } = buildFfmpegCommand(plan)
    const i = args.indexOf('-threads')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('4')
    // An output option: after the inputs, before the output filename.
    expect(i).toBeGreaterThan(args.lastIndexOf('-i'))
    expect(i).toBeLessThan(args.length - 1)
  })

  it('ignores loudness measurements while normalization is disabled', () => {
    // LOUDNORM_ENABLED=false: clips pass through at their recorded level even
    // when pass-1 measurements are supplied. Re-enabling the flag restores the
    // two-pass linear loudnorm
    // (`loudnorm=I=-16:...:measured_I=…:offset=…:linear=true` per clip).
    const plan = planAssembly({ segments: [seg(0, 4), seg(6, 10)], cuts: [], duration: 10 })
    const cmd = buildFfmpegCommand(plan, {
      loudness: [{ i: -27.61, tp: -4.47, lra: 18.06, thresh: -39.2, offset: 0.58 }, null],
    })
    expect(cmd.filterComplex).not.toContain('loudnorm')
  })
})

describe('buildMeasureCommand (loudnorm pass 1)', () => {
  it('decodes the clip through loudnorm print_format=json into the null muxer', () => {
    const { args, input } = buildMeasureCommand('a3.wav')
    expect(input).toBe('a3.wav')
    expect(args).toEqual([
      '-i',
      'a3.wav',
      '-af',
      'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f',
      'null',
      '-',
    ])
  })
})

describe('parseLoudnorm (loudnorm pass 1 output)', () => {
  const logs = [
    'size=N/A time=00:00:02.04 bitrate=N/A speed= 296x',
    '[Parsed_loudnorm_0 @ 0x55] ',
    '{',
    '\t"input_i" : "-27.61",',
    '\t"input_tp" : "-4.47",',
    '\t"input_lra" : "18.06",',
    '\t"input_thresh" : "-39.20",',
    '\t"output_i" : "-16.58",',
    '\t"output_tp" : "-2.21",',
    '\t"output_lra" : "10.00",',
    '\t"output_thresh" : "-27.03",',
    '\t"normalization_type" : "dynamic",',
    '\t"target_offset" : "0.58"',
    '}',
  ]

  it('pulls the measured values out of the JSON block in the log tail', () => {
    expect(parseLoudnorm(logs)).toEqual({
      i: -27.61,
      tp: -4.47,
      lra: 18.06,
      thresh: -39.2,
      offset: 0.58,
    })
  })

  it('returns null when there is no JSON block (clip falls back to single-pass)', () => {
    expect(parseLoudnorm(['frame=1 fps=0', 'no json here'])).toBeNull()
  })

  it('returns null on non-finite measurements (e.g. a silent clip measures -inf)', () => {
    const silent = logs.map((l) => l.replace('"-27.61"', '"-inf"'))
    expect(parseLoudnorm(silent)).toBeNull()
  })
})

describe('planScene (per-scene clip, story 03g phase 2)', () => {
  it('rebases the scene to clip-local time and walks [0, end-start]', () => {
    // Scene spans original 100..160 (a 60s clip). A segment at 110..140 and a cut
    // at 150..155 — both in ORIGINAL seconds — should shift to clip-local.
    const plan = planScene({
      segments: [{ start: 110, end: 140, audioUrl: 'a.wav', audioSeconds: 30 }],
      cuts: [{ start: 150, end: 155 }],
      start: 100,
      end: 160,
    })
    // The segment slice now sits at clip-local 10..40, the cut at 50..55.
    const segSlice = plan.slices.find((s) => s.kind === 'segment')
    expect(segSlice).toMatchObject({ start: 10, end: 40 })
    expect(plan.slices.some((s) => s.kind === 'cut' && s.start === 50 && s.end === 55)).toBe(true)
    // Output keeps everything except the 5s cut: 60 - 5 = 55.
    expect(plan.duration).toBeCloseTo(55, 5)
    // Video pieces trim the CLIP (start at 0), never original-video offsets.
    expect(plan.video[0].start).toBe(0)
    expect(Math.max(...plan.video.map((v) => v.end))).toBeLessThanOrEqual(60)
  })

  it('clamps segments/cuts that spill past the scene bounds', () => {
    const plan = planScene({
      segments: [{ start: 95, end: 130, audioUrl: 'a.wav', audioSeconds: 35 }], // starts before the scene
      cuts: [],
      start: 100,
      end: 120,
    })
    const seg = plan.slices.find((s) => s.kind === 'segment')!
    expect(seg.start).toBe(0) // clamped to clip start
    expect(seg.end).toBe(20) // clamped to clip end (120-100)
  })
})

describe('buildConcatCommand (story 03g phase 2)', () => {
  it('writes a concat list of the parts and joins them with -c copy', () => {
    const cmd = buildConcatCommand(['scene-0.mp4', 'scene-1.mp4', 'scene-2.mp4'])
    expect(cmd.listContent).toBe("file 'scene-0.mp4'\nfile 'scene-1.mp4'\nfile 'scene-2.mp4'\n")
    expect(cmd.args).toEqual(
      expect.arrayContaining(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy']),
    )
    // Stream-copy join: no encoder in the argv.
    expect(cmd.args).not.toContain('libx264')
    expect(cmd.output).toBe('final.mp4')
  })

  it('honors a custom output name', () => {
    const cmd = buildConcatCommand(['a.mp4'], 'out.mp4')
    expect(cmd.output).toBe('out.mp4')
    expect(cmd.args[cmd.args.length - 1]).toBe('out.mp4')
  })

  // Multi-video (story 09d): the final cut is the in-order concat of each scene's
  // own assembled clip. Scenes can come from DIFFERENT source videos, but the
  // concat is purely positional — it lists the parts exactly as given (scene
  // order), with no source/timeline coordinate involved. So a project whose scenes
  // span several sources stitches correctly as long as the parts are passed in
  // scene order. (Per-scene assemble already works on each scene's LOCAL bounds —
  // `planAssembly`/`buildSlices` take only {segments, cuts, duration}, never a
  // sourceId — so the export path is source-agnostic by construction.)
  it('concats scene clips from multiple sources in scene order, unchanged', () => {
    // e.g. scenes 0-1 from video A, scenes 2-3 from video B — assembledUrl order
    // is scene order; the source they came from never enters the concat.
    const parts = ['scene-0.mp4', 'scene-1.mp4', 'scene-2.mp4', 'scene-3.mp4']
    const cmd = buildConcatCommand(parts)
    expect(cmd.listContent).toBe(parts.map((p) => `file '${p}'`).join('\n') + '\n')
    // Order is preserved verbatim — reversing the parts reverses the list.
    expect(buildConcatCommand([...parts].reverse()).listContent).toBe(
      [...parts].reverse().map((p) => `file '${p}'`).join('\n') + '\n',
    )
  })
})
