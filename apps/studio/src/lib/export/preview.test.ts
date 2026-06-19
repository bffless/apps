import { describe, it, expect } from 'vitest'
import { planScene, type AssemblePlan, type AssembleSegment } from './assemble'
import { audioEvents, sourceTimeAt, scheduleFrom, type AudioEvent } from './preview'

/** A voiced segment (has an audio clip) over `[start, end]`, original-video seconds. */
function seg(start: number, end: number, audioSeconds = end - start) {
  return { start, end, audioUrl: `clip-${start}-${end}.wav`, audioSeconds }
}

describe('audioEvents — clip offsets on the output timeline', () => {
  it('a clip after leading dead space starts at the dead-space length', () => {
    // Scene [0,10]: dead 0–4, segment 4–8 (4s clip), dead 8–10.
    const segments = [seg(4, 8)]
    const plan = planScene({ segments, cuts: [], start: 0, end: 10 })
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 0, audioUrl: 'clip-4-8.wav', offset: 4, duration: 4 },
    ])
  })

  it('a cut before a clip pulls its offset earlier (cut footage is dropped)', () => {
    // Cut 0–3, segment 4–8 → output: dead 3–4 (1s), then the clip at offset 1.
    const segments = [seg(4, 8)]
    const plan = planScene({ segments, cuts: [{ start: 0, end: 3 }], start: 0, end: 10 })
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 0, audioUrl: 'clip-4-8.wav', offset: 1, duration: 4 },
    ])
  })

  it('clip duration is the plan audioSeconds (already clamped to the slot)', () => {
    // 6s slot but only a 2.5s clip → plays 2.5s, the rest of the slot is silent padding.
    const segments = [seg(0, 6, 2.5)]
    const plan = planScene({ segments, cuts: [], start: 0, end: 6 })
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 0, audioUrl: 'clip-0-6.wav', offset: 0, duration: 2.5 },
    ])
  })

  it('unvoiced segments produce no event (planAssembly already made them silence)', () => {
    const segments: AssembleSegment[] = [{ start: 0, end: 4 }, seg(6, 10)]
    const plan = planScene({ segments, cuts: [], start: 0, end: 10 })
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 1, audioUrl: 'clip-6-10.wav', offset: 6, duration: 4 },
    ])
  })

  it('defensive: a clip piece whose segment lost its url is skipped, offsets intact', () => {
    // Hand-built plan (not via planScene) — the url lookup must not throw.
    const plan: AssemblePlan = {
      slices: [],
      video: [{ start: 0, end: 10 }],
      audio: [
        { kind: 'clip', segmentIndex: 0, length: 4, audioSeconds: 4 },
        { kind: 'clip', segmentIndex: 1, length: 6, audioSeconds: 6 },
      ],
      duration: 10,
    }
    const segments: AssembleSegment[] = [{ start: 0, end: 4 }, seg(4, 10)]
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 1, audioUrl: 'clip-4-10.wav', offset: 4, duration: 6 },
    ])
  })

  it('scene-rebased plans keep working (planScene shifts to clip-local time)', () => {
    // Scene [100,110], segment 102–106 → clip-local: dead 0–2, clip at offset 2.
    const segments = [seg(102, 106)]
    const plan = planScene({ segments, cuts: [], start: 100, end: 110 })
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 0, audioUrl: 'clip-102-106.wav', offset: 2, duration: 4 },
    ])
  })

  it('two voiced segments accumulate offsets through the emitted clips', () => {
    // Scene [0,10]: clip 0–3, dead 3–5, clip 5–8, dead 8–10.
    const segments = [seg(0, 3), seg(5, 8)]
    const plan = planScene({ segments, cuts: [], start: 0, end: 10 })
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 0, audioUrl: 'clip-0-3.wav', offset: 0, duration: 3 },
      { segmentIndex: 1, audioUrl: 'clip-5-8.wav', offset: 5, duration: 3 },
    ])
  })

  it('a segment split by an internal cut stays ONE clip piece (narration continuous across the join)', () => {
    // Segment 0–10 with cut 4–6: kept video is 0–4 + 6–10 (8s), coalesced into one
    // 8s slot — the narration plays straight through the join, matching the render.
    const segments = [seg(0, 10, 8)]
    const plan = planScene({ segments, cuts: [{ start: 4, end: 6 }], start: 0, end: 10 })
    expect(audioEvents(plan, segments)).toEqual([
      { segmentIndex: 0, audioUrl: 'clip-0-10.wav', offset: 0, duration: 8 },
    ])
  })
})

describe('sourceTimeAt — output clock → original-video seconds for the flipbook', () => {
  it('with no cuts the mapping is identity (plus the scene offset)', () => {
    const plan = planScene({ segments: [seg(0, 10)], cuts: [], start: 0, end: 10 })
    expect(sourceTimeAt(plan, 3, 0)).toBe(3)
    expect(sourceTimeAt(plan, 3, 100)).toBe(103)
  })

  it('jumps across a cut: output time past the first kept piece lands after the cut', () => {
    // Kept 0–5, cut 5–8, kept 8–10 → output [0,7]; t=5 is the cut boundary → source 8.
    const plan = planScene({ segments: [seg(0, 10)], cuts: [{ start: 5, end: 8 }], start: 0, end: 10 })
    expect(sourceTimeAt(plan, 4, 0)).toBe(4)
    expect(sourceTimeAt(plan, 5, 0)).toBe(5) // boundary belongs to the earlier piece's end
    expect(sourceTimeAt(plan, 6, 0)).toBe(9) // 1s into the second kept piece (starts at 8)
  })

  it('clamps t to [0, duration]', () => {
    const plan = planScene({ segments: [seg(0, 10)], cuts: [{ start: 5, end: 8 }], start: 0, end: 10 })
    expect(sourceTimeAt(plan, -1, 0)).toBe(0)
    expect(sourceTimeAt(plan, 99, 0)).toBe(10) // end of the last kept piece
  })

  it('an empty plan returns the scene start', () => {
    const plan = planScene({ segments: [], cuts: [{ start: 0, end: 10 }], start: 0, end: 10 })
    expect(sourceTimeAt(plan, 0, 100)).toBe(100)
  })
})

describe('scheduleFrom — which clips play (and from where) when starting at an offset', () => {
  const events: AudioEvent[] = [
    { segmentIndex: 0, audioUrl: 'a.wav', offset: 2, duration: 4 }, // plays [2,6]
    { segmentIndex: 1, audioUrl: 'b.wav', offset: 8, duration: 3 }, // plays [8,11]
  ]

  it('offset 0: everything is in the future, untouched', () => {
    expect(scheduleFrom(events, 0)).toEqual([
      { event: events[0], when: 2, bufferOffset: 0, duration: 4 },
      { event: events[1], when: 8, bufferOffset: 0, duration: 3 },
    ])
  })

  it('mid-flight: a clip already playing starts now, partway into its buffer', () => {
    expect(scheduleFrom(events, 4)).toEqual([
      { event: events[0], when: 0, bufferOffset: 2, duration: 2 },
      { event: events[1], when: 4, bufferOffset: 0, duration: 3 },
    ])
  })

  it('finished clips are dropped (including exactly-at-end)', () => {
    expect(scheduleFrom(events, 6)).toEqual([
      { event: events[1], when: 2, bufferOffset: 0, duration: 3 },
    ])
  })

  it('a clip starting exactly at the offset plays immediately from its top', () => {
    expect(scheduleFrom(events, 8)).toEqual([
      { event: events[1], when: 0, bufferOffset: 0, duration: 3 },
    ])
  })

  it('an offset past everything schedules nothing', () => {
    expect(scheduleFrom(events, 12)).toEqual([])
  })
})
