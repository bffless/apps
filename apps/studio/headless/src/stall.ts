/**
 * Freeze detection for the long phases.
 *
 * The build phase's progress line is the only observable the runner has: it
 * re-reads the board every few seconds and prints `scene 1 — assemble running`.
 * A wedged job looks EXACTLY like slow progress — the same line, forever —
 * so an unattended run used to burn the whole 90-minute build budget before
 * anything failed (apps#339, where a server-side ffmpeg job never settled and
 * the line sat unchanged for the 12 minutes before the run was killed).
 *
 * This turns "unchanged for too long" into evidence and then into a failure:
 * a screenshot every `shotEveryMs` (capped, so a generous ceiling can't flood
 * the artifacts) and a hard verdict at `failAfterMs`. Any change to the line
 * resets the clock, so a slow-but-moving build is never punished.
 */
export interface StallWatchOptions {
  /** Capture a stall screenshot each time the line has been frozen this long. */
  shotEveryMs: number
  /** Give up once the line has been frozen this long. */
  failAfterMs: number
  /** Most screenshots to ask for in a single freeze. */
  maxShots: number
}

export type StallVerdict = {
  action: 'none' | 'shot' | 'fail'
  /** How long the current description has been unchanged. */
  stalledMs: number
  /** 1-based screenshot number, on `shot` only. */
  shot?: number
}

export interface StallWatch {
  /** Feed the current progress line and clock; returns what the caller should do. */
  observe(desc: string, nowMs: number): StallVerdict
}

export function createStallWatch(opts: StallWatchOptions): StallWatch {
  let lastDesc: string | null = null
  let lastChangeAt = 0
  let shots = 0
  return {
    observe(desc, nowMs) {
      if (desc !== lastDesc) {
        lastDesc = desc
        lastChangeAt = nowMs
        shots = 0
        return { action: 'none', stalledMs: 0 }
      }
      const stalledMs = nowMs - lastChangeAt
      if (stalledMs >= opts.failAfterMs) return { action: 'fail', stalledMs }
      if (shots < opts.maxShots && stalledMs >= opts.shotEveryMs * (shots + 1)) {
        shots += 1
        return { action: 'shot', stalledMs, shot: shots }
      }
      return { action: 'none', stalledMs }
    },
  }
}
