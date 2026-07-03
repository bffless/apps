/**
 * Assemble — the pure plan for a render (story 05, reshaped by ADR-0003).
 *
 * Cut-first: there is one source clip and one flat list of `cuts[]` (footage
 * spans to drop). The render is simply the **kept spans of the clip, in order,
 * with the clip's own audio** — no narration clips, no silence fill, nothing
 * mixed. Video and audio are trimmed with the exact same spans, so they stay in
 * sync by construction.
 *
 * The one polish step: a ~10 ms audio fade on each kept piece's edges, so the
 * hard joins between discontinuous source spans don't click.
 *
 * This module is **pure** (no ffmpeg import) and unit-tested. ffmpeg.wasm is a
 * dumb executor of the command this builds — see `./ffmpeg.ts`.
 */

import type { Cut } from '../scenes'

/** Float slop for boundary/zero-length comparisons (matches the refiner's). */
const EPS = 0.001

export type AssembleInput = {
  /** The spans to drop, flat, in source seconds. May overlap; normalized here. */
  cuts: Cut[]
  /** Source clip length in seconds — the timeline we walk is `[0, duration]`. */
  duration: number
}

/** A piece of kept source footage to concat — video AND audio trim of the source. */
export type VideoPiece = { start: number; end: number }

export type AssemblePlan = {
  /** Kept footage, in order — each a `trim` of the source. */
  video: VideoPiece[]
  /** Total output length: the source minus all cut footage. */
  duration: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** Sort + merge the cuts into a clean, non-overlapping, clamped list. */
function normalize(cuts: Cut[], duration: number): Cut[] {
  const sorted = cuts
    .map((c) => ({ start: clamp(c.start, 0, duration), end: clamp(c.end, 0, duration) }))
    .filter((c) => c.end - c.start > EPS)
    .sort((a, b) => a.start - b.start)
  const out: Cut[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end + EPS) last.end = Math.max(last.end, c.end)
    else out.push({ ...c })
  }
  return out
}

/**
 * Walk `[0, duration]` and emit the kept spans between the cuts, in order.
 * Sub-EPS kept slivers between adjacent cuts are dropped (a one-frame flash is
 * never wanted). Trailing footage past the last cut is honored, not trimmed —
 * the export matches what the cut grid shows.
 */
export function planAssembly(input: AssembleInput): AssemblePlan {
  const video: VideoPiece[] = []
  if (Number.isFinite(input.duration) && input.duration > 0) {
    let cursor = 0
    for (const c of normalize(input.cuts, input.duration)) {
      if (c.start - cursor > EPS) video.push({ start: cursor, end: c.start })
      cursor = Math.max(cursor, c.end)
    }
    if (input.duration - cursor > EPS) video.push({ start: cursor, end: input.duration })
  }
  const duration = video.reduce((n, v) => n + (v.end - v.start), 0)
  return { video, duration }
}

/** Trim trailing zeros off a fixed-precision seconds value for the filter graph. */
function secs(v: number): string {
  return Number(v.toFixed(3)).toString()
}

export type FfmpegCommand = {
  /** The `filter_complex` graph string. */
  filterComplex: string
  /** The full ffmpeg argv (the source clip is the only input). */
  args: string[]
}

/** Fade length (seconds) ramped on each kept piece's audio edges to kill the
 *  clicks at cut joins. */
const FADE = 0.01

/**
 * Build the ffmpeg invocation from a plan: per kept piece, a video `trim` and an
 * audio `atrim` of the SAME span (the clip's own soundtrack — nothing is
 * re-voiced), with short edge fades on the audio; then one interleaved concat of
 * both streams. Single-threaded-friendly (libx264 `ultrafast`).
 */
export function buildFfmpegCommand(
  plan: AssemblePlan,
  opts: { source?: string; output?: string; audioPolish?: boolean } = {},
): FfmpegCommand {
  const source = opts.source ?? 'source.mp4'
  const output = opts.output ?? 'out.mp4'
  const polish = opts.audioPolish !== false
  const parts: string[] = []

  plan.video.forEach((v, i) => {
    const len = v.end - v.start
    parts.push(`[0:v]trim=${secs(v.start)}:${secs(v.end)},setpts=PTS-STARTPTS[v${i}]`)
    // Fades measure from the rebased (asetpts) piece start; the out-fade anchors
    // at the piece's own end, clamped so a tiny piece never fades before 0.
    const fadeOut = Math.max(0, len - FADE)
    const fade = polish
      ? `,afade=t=in:st=0:d=${secs(FADE)},afade=t=out:st=${secs(fadeOut)}:d=${secs(FADE)}`
      : ''
    parts.push(
      `[0:a]atrim=${secs(v.start)}:${secs(v.end)},asetpts=PTS-STARTPTS${fade}[a${i}]`,
    )
  })
  const labels = plan.video.map((_, i) => `[v${i}][a${i}]`).join('')
  parts.push(`${labels}concat=n=${plan.video.length}:v=1:a=1[vout][aout]`)

  const filterComplex = parts.join(';')
  const args = [
    '-i',
    source,
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    // Cap x264's thread pool: under the multithreaded core it defaults to the
    // machine's core count, and each frame thread allocates its own full-res
    // buffers inside the fixed-size wasm heap — unbounded, that's an OOM at
    // encoder init. 4 keeps most of the speedup with a bounded footprint.
    '-threads',
    '4',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    output,
  ]
  return { filterComplex, args }
}

/**
 * Plan one scene's assemble against **its own clip** (story 03g phase 2).
 *
 * The producer cuts each scene into a standalone clip whose timeline is
 * `[0, end − start]` (`scene.clipUrl`). The scene's cuts, however, are still in
 * **original-video** seconds. This rebases them to clip-local time by
 * subtracting `start` (clamped into the clip), then runs the same `planAssembly`
 * walk over `[0, end − start]`. The returned plan's pieces therefore `trim` the
 * small clip — not the whole film — so assembling a scene only ever holds one
 * short clip in wasm memory (the fix for the whole-film OOM).
 */
export function planScene(input: {
  cuts: Cut[]
  /** Scene bounds in original-video seconds. */
  start: number
  end: number
}): AssemblePlan {
  const dur = Math.max(0, input.end - input.start)
  const shift = (v: number) => clamp(v - input.start, 0, dur)
  const cuts = input.cuts.map((c) => ({ start: shift(c.start), end: shift(c.end) }))
  return planAssembly({ cuts, duration: dur })
}

export type ConcatCommand = {
  /** The full ffmpeg argv for the concat-demuxer join. */
  args: string[]
  /** Virtual-FS name of the concat list file the executor must write. */
  listName: string
  /** Contents of that list file (one `file '<part>'` line per part, in order). */
  listContent: string
  /** Output filename the finished cut is read back from. */
  output: string
}

/**
 * Build the final **stream-copy concat** of the per-scene MP4s (story 03g phase 2).
 *
 * Every scene clip is encoded with the same profile (`libx264`/`yuv420p`/aac, same
 * resolution), so the concat demuxer can join them with `-c copy`: no re-encode,
 * near-instant, and almost no memory (it just rewrites the container). Scenes may
 * be slices of DIFFERENT source videos (multi-video, story 09d) — the concat is
 * purely positional, so it stitches them in the order given (scene order) with no
 * source/timeline coordinate involved. `-fflags +genpts` regenerates presentation
 * timestamps so the boundary between scenes is clean.
 */
export function buildConcatCommand(parts: string[], output = 'final.mp4'): ConcatCommand {
  const listName = 'concat.txt'
  const listContent = parts.map((p) => `file '${p}'`).join('\n') + '\n'
  const args = [
    '-f',
    'concat',
    '-safe',
    '0',
    '-fflags',
    '+genpts',
    '-i',
    listName,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    output,
  ]
  return { args, listName, listContent, output }
}
