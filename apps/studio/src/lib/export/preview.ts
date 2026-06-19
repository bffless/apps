/**
 * Preview — pure timeline math for the scene preview player (story 03i).
 *
 * The preview SIMULATES an `AssemblePlan` (the same pure plan ffmpeg renders —
 * see ./assemble.ts) with zero rendering: narration clips are scheduled on a
 * Web Audio clock at their output-timeline offsets, and the flipbook maps the
 * output clock back to original-video seconds to pick a contact-sheet frame.
 * This module is pure (no DOM, no Web Audio) and unit-tested; the transport
 * hook and the dialog are thin shells over it.
 */

import type { AssemblePlan } from './assemble'

/** A segment as the preview needs it — just the voiced clip, if any. */
export type PreviewSegment = { audioUrl?: string }

/** One narration clip placed on the output timeline. */
export type AudioEvent = {
  segmentIndex: number
  audioUrl: string
  /** Output-timeline second this clip starts at. */
  offset: number
  /** Seconds of the clip that play (planAssembly already clamped ≤ its slot). */
  duration: number
}

/**
 * Walk `plan.audio` accumulating output time: silence pieces just advance the
 * clock; clip pieces emit an event at the current offset. A clip piece whose
 * segment has no `audioUrl` is skipped (planAssembly never emits those, but a
 * hand-built or stale plan must degrade to silence, not throw — the same
 * "never reference a missing input" rule the assembler follows).
 */
export function audioEvents(plan: AssemblePlan, segments: PreviewSegment[]): AudioEvent[] {
  const events: AudioEvent[] = []
  let t = 0
  for (const piece of plan.audio) {
    if (piece.kind === 'clip') {
      const audioUrl = segments[piece.segmentIndex]?.audioUrl
      if (audioUrl) {
        events.push({ segmentIndex: piece.segmentIndex, audioUrl, offset: t, duration: piece.audioSeconds })
      }
    }
    t += piece.length
  }
  return events
}

/**
 * Map an output-timeline second to ORIGINAL-VIDEO seconds, for the filmstrip
 * lookup. Walks `plan.video` (kept source spans, clip-local time) accumulating
 * piece lengths; `sceneStart` lifts the clip-local result back to the original
 * timeline (`planScene` rebased everything by subtracting it). `t` clamps to
 * `[0, plan.duration]`; an all-cut plan (no video) returns `sceneStart`.
 */
export function sourceTimeAt(plan: AssemblePlan, t: number, sceneStart: number): number {
  const last = plan.video[plan.video.length - 1]
  if (!last) return sceneStart
  const clamped = Math.min(Math.max(t, 0), plan.duration)
  let acc = 0
  for (const piece of plan.video) {
    const len = piece.end - piece.start
    if (clamped <= acc + len) return sceneStart + piece.start + (clamped - acc)
    acc += len
  }
  return sceneStart + last.end
}

/** An event ready for `AudioBufferSourceNode.start(base + when, bufferOffset, duration)`. */
export type ScheduledEvent = {
  event: AudioEvent
  /** Seconds from "now" until this clip starts (0 = immediately). */
  when: number
  /** Seconds into the clip's buffer to start from (mid-flight seek). */
  bufferOffset: number
  /** Seconds of the buffer to play. */
  duration: number
}

/**
 * The seek math: given playback starting at output-second `offset`, future
 * events keep their relative delay, an event already underway starts now but
 * partway into its buffer, and an event that already finished is dropped.
 */
export function scheduleFrom(events: AudioEvent[], offset: number): ScheduledEvent[] {
  const out: ScheduledEvent[] = []
  for (const event of events) {
    if (event.offset >= offset) {
      out.push({ event, when: event.offset - offset, bufferOffset: 0, duration: event.duration })
    } else {
      const into = offset - event.offset
      if (into < event.duration) {
        out.push({ event, when: 0, bufferOffset: into, duration: event.duration - into })
      }
    }
  }
  return out
}
