/**
 * Assemble — the pure plan for the final cut (story 05).
 *
 * The whole render is **one walk of the original timeline**. There is one source
 * video and two flat lists (gathered across every scene's effective layer):
 * `cuts[]` (footage spans to drop) and `segments[]` (the re-voiced narration
 * clips, each anchored to original-video seconds). Every slice of the timeline is
 * in exactly one of three states, and that state decides what it contributes:
 *
 *   | state   | the slice is…                       | video   | audio          |
 *   |---------|-------------------------------------|---------|----------------|
 *   | cut     | inside a `cuts[]` span              | dropped | —              |
 *   | segment | inside a `segments[]` span, not cut | kept    | that clip      |
 *   | dead    | neither cut nor segment             | kept    | silence        |
 *
 * **Cut wins on overlap** — where a segment and a cut overlap, the cut removes
 * that footage, so a segment's kept video is its span minus the cuts inside it.
 *
 * Because the video track (kept footage) and the audio track (segment clips +
 * silence) are built from the **same walk**, they come out the same length and in
 * sync automatically — no footage-fit, no stretching (the edit UI already keeps
 * each kept span's audio ≤ its video). The one robustness step we DO take is
 * per-segment: pad (or, rarely, trim) the audio clip to its kept-video length so
 * the two tracks line up to the millisecond.
 *
 * **Trailing dead space is honored, not trimmed.** Whatever footage the producer
 * left uncut past the last segment is kept as silent video, so the export matches
 * what the diff grid shows. We walk `[0, duration]` regardless of where the
 * scenes/segments stop, so a tail with no narration just becomes a `dead` slice.
 *
 * This module is **pure** (no ffmpeg import) and unit-tested. ffmpeg.wasm is a
 * dumb executor of the command this builds — see `./ffmpeg.ts`.
 */

import type { Cut } from '../scenes'

/** Float slop for boundary/zero-length comparisons (matches the refiner's). */
const EPS = 0.001

/** A segment as assemble needs it: its span plus, once voiced, the audio clip. */
export type AssembleSegment = {
  start: number
  end: number
  /** Serve path / data URL of this run's audio, once voiced. Absent → silence. */
  audioUrl?: string
  /** Real measured length of that audio clip, in seconds. */
  audioSeconds?: number
}

export type AssembleInput = {
  /** Every scene's effective narration segments, flat and in timeline order. */
  segments: AssembleSegment[]
  /** Every scene's effective cuts, flat. */
  cuts: Cut[]
  /** Source clip length in seconds — the timeline we walk is `[0, duration]`. */
  duration: number
}

/** One slice of the original timeline, tagged with the state that owns it. */
export type Slice =
  | { kind: 'cut'; start: number; end: number }
  | { kind: 'dead'; start: number; end: number }
  | { kind: 'segment'; start: number; end: number; segmentIndex: number }

/** A piece of kept source footage to concat into the video track. */
export type VideoPiece = { start: number; end: number }

/** A piece of the audio track: a segment's clip (padded to `length`) or silence. */
export type AudioPiece =
  | {
      kind: 'clip'
      segmentIndex: number
      /** Output length of this piece (the kept-video length it covers). */
      length: number
      /** The real clip duration, so the graph can fade out at the audio's own end
       *  (before the trailing silence padding) — not at the padded `length`. */
      audioSeconds: number
    }
  | { kind: 'silence'; length: number }

export type AssemblePlan = {
  slices: Slice[]
  /** Kept footage, in order — each a `trim` of the source. Sums to `duration`. */
  video: VideoPiece[]
  /** The audio track, in order. Sums to the same `duration` as the video. */
  audio: AudioPiece[]
  /** Total output length: the source minus all cut footage. */
  duration: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/**
 * Walk the original timeline `[0, duration]` and tag every slice cut / segment /
 * dead. Boundaries are the clip ends plus every cut and segment edge; between two
 * adjacent boundaries the state is constant, so we classify each slice by its
 * midpoint. **Cut wins**: a midpoint inside any cut is `cut` even if a segment
 * also covers it. Adjacent slices of the same state (same segment, for segments)
 * are coalesced so the plan stays tidy.
 */
export function buildSlices({ segments, cuts, duration }: AssembleInput): Slice[] {
  if (!Number.isFinite(duration) || duration <= 0) return []

  const segs = segments
    .map((s) => ({ start: clamp(s.start, 0, duration), end: clamp(s.end, 0, duration) }))
    .filter((s) => s.end - s.start > EPS)
  const drops = cuts
    .map((c) => ({ start: clamp(c.start, 0, duration), end: clamp(c.end, 0, duration) }))
    .filter((c) => c.end - c.start > EPS)

  const bounds = new Set<number>([0, duration])
  for (const s of segs) {
    bounds.add(s.start)
    bounds.add(s.end)
  }
  for (const c of drops) {
    bounds.add(c.start)
    bounds.add(c.end)
  }
  const sorted = [...bounds].sort((a, b) => a - b)

  const out: Slice[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]
    const end = sorted[i + 1]
    if (end - start <= EPS) continue
    const mid = (start + end) / 2

    let slice: Slice
    if (drops.some((c) => mid >= c.start && mid <= c.end)) {
      slice = { kind: 'cut', start, end }
    } else {
      // Segments don't overlap, so at most one owns the midpoint.
      const idx = segs.findIndex((s) => mid >= s.start && mid <= s.end)
      slice = idx === -1 ? { kind: 'dead', start, end } : { kind: 'segment', start, end, segmentIndex: idx }
    }

    const last = out[out.length - 1]
    const sameRun =
      last &&
      last.kind === slice.kind &&
      (slice.kind !== 'segment' || last.kind !== 'segment' || last.segmentIndex === slice.segmentIndex)
    if (sameRun) last.end = end
    else out.push(slice)
  }
  return out
}

/**
 * Turn an input into the ordered video + audio pieces ffmpeg concatenates.
 *
 * - **Video** = every non-cut slice as its own source `trim`. A segment split by
 *   an internal cut keeps its two kept sub-spans as two separate trims (they're
 *   discontinuous in the source), which become contiguous once the cut is removed.
 * - **Audio** = walk the same kept slices: a `dead` slice → silence of its length;
 *   consecutive slices of one segment → a single clip piece whose `length` is
 *   their total kept-video length (so the clip, padded to that, covers the
 *   segment's whole kept region). A segment with no `audioUrl` (not voiced) →
 *   silence, so the graph never references a missing input.
 *
 * Both tracks sum to the same `duration`, so they're equal length by construction.
 */
export function planAssembly(input: AssembleInput): AssemblePlan {
  const slices = buildSlices(input)
  const kept = slices.filter((s) => s.kind !== 'cut')

  const video: VideoPiece[] = kept.map((s) => ({ start: s.start, end: s.end }))

  const audio: AudioPiece[] = []
  for (let i = 0; i < kept.length; ) {
    const s = kept[i]
    if (s.kind === 'dead') {
      audio.push({ kind: 'silence', length: s.end - s.start })
      i++
      continue
    }
    // s.kind === 'segment' — gather consecutive kept slices of this same segment.
    const idx = s.segmentIndex
    let length = 0
    while (i < kept.length) {
      const k = kept[i]
      if (k.kind !== 'segment' || k.segmentIndex !== idx) break
      length += k.end - k.start
      i++
    }
    const seg = input.segments[idx]
    const voiced = !!seg?.audioUrl
    if (voiced) {
      // Fade-out anchors on the clip's own end; if its real length is unknown or
      // longer than the slot, clamp to the slot so we never fade into nothing.
      const audioSeconds = Math.min(seg.audioSeconds && seg.audioSeconds > 0 ? seg.audioSeconds : length, length)
      audio.push({ kind: 'clip', segmentIndex: idx, length, audioSeconds })
    } else {
      audio.push({ kind: 'silence', length })
    }
  }

  const duration = video.reduce((n, v) => n + (v.end - v.start), 0)
  return { slices, video, audio, duration }
}

/** Trim trailing zeros off a fixed-precision seconds value for the filter graph. */
function secs(v: number): string {
  return Number(v.toFixed(3)).toString()
}

export type FfmpegCommand = {
  /** The `filter_complex` graph string. */
  filterComplex: string
  /** The full ffmpeg argv (source is input 0, clips follow in `audioInputs` order). */
  args: string[]
  /** The segment index behind each extra audio input, in `-i` order. The executor
   *  provides one file per entry (`a0.wav`, `a1.wav`, …). */
  audioInputs: number[]
}

/** Common output audio format — every clip is resampled to this before concat. */
const SAMPLE_RATE = 48000
/** EBU R128 loudness target each clip is normalized to (LUFS / dBTP / LU). */
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'
/** Fade length (seconds) ramped on each clip's edges to kill concat-join clicks. */
const FADE = 0.01

/**
 * Loudness normalization is **switched off** for now: single-pass loudnorm
 * audibly stepped the volume between the short narration clips, and the
 * measured two-pass replacement still didn't sound right in practice — so
 * clips currently play at their recorded level (the edge fades stay; they're
 * what kills the clicks at joins, and were never the problem). All of the
 * two-pass machinery (measure command, stats parsing, `opts.loudness`,
 * `measureLoudness` in ./ffmpeg.ts and the pass-1 loop in SceneAssembleBar)
 * keys off this one flag — flip it to true to bring everything back.
 */
export const LOUDNORM_ENABLED = false

/**
 * One clip's measured loudness (loudnorm pass 1): integrated LUFS, true peak,
 * loudness range, gating threshold, and the target offset — exactly what pass 2
 * feeds back as `measured_*`/`offset` to get a **linear** (constant-gain)
 * correction instead of the single-pass dynamic one.
 */
export type LoudnormStats = {
  i: number
  tp: number
  lra: number
  thresh: number
  offset: number
}

/**
 * Pass 1 of two-pass loudnorm: decode one clip through `loudnorm` in
 * measurement mode (`print_format=json`, null muxer — no output file). The
 * stats land in ffmpeg's log; `parseLoudnorm` pulls them out.
 */
export function buildMeasureCommand(input: string): { args: string[]; input: string } {
  return {
    input,
    args: ['-i', input, '-af', `${LOUDNORM}:print_format=json`, '-f', 'null', '-'],
  }
}

/**
 * Extract the measured loudness from a measure run's log lines. loudnorm prints
 * a flat JSON block at the end; values are strings ("-27.61", or "-inf" for
 * silence). Returns null when there's no parsable block or any value is
 * non-finite — callers then keep that clip on the single-pass dynamic loudnorm,
 * so a weird clip degrades to today's behavior instead of failing the render.
 */
export function parseLoudnorm(logLines: string[]): LoudnormStats | null {
  const text = logLines.join('\n')
  const blocks = text.match(/\{[^{}]*"input_i"[^{}]*\}/g)
  if (!blocks) return null
  try {
    const raw = JSON.parse(blocks[blocks.length - 1]) as Record<string, string>
    const stats = {
      i: Number(raw.input_i),
      tp: Number(raw.input_tp),
      lra: Number(raw.input_lra),
      thresh: Number(raw.input_thresh),
      offset: Number(raw.target_offset),
    }
    return Object.values(stats).every(Number.isFinite) ? stats : null
  } catch {
    return null
  }
}

/** Format a measured dB/LU value for the filter graph (trim trailing zeros). */
const db = (v: number) => Number(v.toFixed(2)).toString()

/** The pass-2 loudnorm filter: linear constant gain from pass-1 measurements. */
function loudnormFor(stats: LoudnormStats | null | undefined): string {
  if (!stats) return LOUDNORM
  return (
    `${LOUDNORM}:measured_I=${db(stats.i)}:measured_TP=${db(stats.tp)}` +
    `:measured_LRA=${db(stats.lra)}:measured_thresh=${db(stats.thresh)}` +
    `:offset=${db(stats.offset)}:linear=true`
  )
}

/**
 * Build the ffmpeg invocation from a plan. The video track trims + concats the
 * kept footage; the audio track, per clip: normalizes loudness, resamples to a
 * common format, fades its edges, pads to its piece length (silence fills any tail
 * where the kept video runs longer than the narration), then concats those with
 * generated silence for dead space.
 *
 * **Audio polish (story 05 follow-up).** `loudnorm` levels every clip to one
 * target so the `original` screen-rec audio and the mic/AI takes don't jump in
 * volume back-to-back (the most audible artifact). Pass `opts.loudness` (pass-1
 * measurements, aligned with the command's `audioInputs` order) to upgrade each
 * clip to **two-pass linear** loudnorm — a single constant gain per clip. Without
 * it, single-pass dynamic loudnorm varies its gain *within* a clip and is
 * unreliable under ~3 s, which itself causes audible level steps between the
 * short narration clips (the bug this fixes); a clip whose measurement failed
 * (null entry) keeps the dynamic fallback. Short `afade` in/out on each
 * clip kills the clicks at concat joins. We deliberately do NOT use `acrossfade`:
 * a real crossfade overlaps (and shortens) the audio, which would break the
 * equal-length video/audio invariant the whole walk relies on; per-clip edge fades
 * preserve it. All three (loudnorm, both fades) keep the piece's length exactly
 * `length` via the trailing `apad`→`atrim`, so the tracks stay in sync. Toggle off
 * with `opts.audioPolish = false`.
 *
 * Single-threaded-friendly (libx264 `ultrafast`).
 */
export function buildFfmpegCommand(
  plan: AssemblePlan,
  opts: {
    source?: string
    output?: string
    audioPolish?: boolean
    /** Pass-1 loudness per extra audio input (same order as `audioInputs`). */
    loudness?: (LoudnormStats | null)[]
  } = {},
): FfmpegCommand {
  const source = opts.source ?? 'source.mp4'
  const output = opts.output ?? 'out.mp4'
  const polish = opts.audioPolish !== false
  const parts: string[] = []

  plan.video.forEach((v, i) => {
    parts.push(`[0:v]trim=${secs(v.start)}:${secs(v.end)},setpts=PTS-STARTPTS[v${i}]`)
  })
  const vlabels = plan.video.map((_, i) => `[v${i}]`).join('')
  parts.push(`${vlabels}concat=n=${plan.video.length}:v=1:a=0[vout]`)

  const audioInputs: number[] = []
  let inputIdx = 1 // input 0 is the source video
  plan.audio.forEach((a, i) => {
    if (a.kind === 'silence') {
      parts.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=0:${secs(a.length)},asetpts=PTS-STARTPTS[a${i}]`)
    } else {
      const j = inputIdx++
      audioInputs.push(a.segmentIndex)
      // loudnorm first (on the raw clip), then to the common format, then fades:
      // in at the start, out anchored at the clip's own end (clamped so a fade
      // never starts before 0), then pad+trim to the exact slot length.
      const fadeOut = Math.max(0, a.audioSeconds - FADE)
      const norm = polish && LOUDNORM_ENABLED ? `${loudnormFor(opts.loudness?.[j - 1])},` : ''
      const fade = polish ? `afade=t=in:st=0:d=${secs(FADE)},afade=t=out:st=${secs(fadeOut)}:d=${secs(FADE)},` : ''
      parts.push(
        `[${j}:a]${norm}aresample=${SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono,` +
          `${fade}apad,atrim=0:${secs(a.length)},asetpts=PTS-STARTPTS[a${i}]`,
      )
    }
  })
  const alabels = plan.audio.map((_, i) => `[a${i}]`).join('')
  parts.push(`${alabels}concat=n=${plan.audio.length}:v=0:a=1[aout]`)

  const filterComplex = parts.join(';')
  const args = [
    '-i',
    source,
    ...audioInputs.flatMap((_, k) => ['-i', `a${k}.wav`]),
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
  return { filterComplex, args, audioInputs }
}

/**
 * Plan one scene's assemble against **its own clip** (story 03g phase 2).
 *
 * The producer cuts each scene into a standalone clip whose timeline is
 * `[0, end − start]` (`scene.clipUrl`). The scene's segments and cuts, however, are
 * still in **original-video** seconds. This rebases them to clip-local time by
 * subtracting `start` (clamped into the clip), then runs the same `planAssembly`
 * walk over `[0, end − start]`. The returned plan's video pieces therefore `trim`
 * the small clip — not the whole film — so assembling a scene only ever holds one
 * short clip in wasm memory (the fix for the whole-film OOM).
 */
export function planScene(input: {
  segments: AssembleSegment[]
  cuts: Cut[]
  /** Scene bounds in original-video seconds. */
  start: number
  end: number
}): AssemblePlan {
  const dur = Math.max(0, input.end - input.start)
  const shift = (v: number) => clamp(v - input.start, 0, dur)
  const segments = input.segments.map((s) => ({ ...s, start: shift(s.start), end: shift(s.end) }))
  const cuts = input.cuts.map((c) => ({ start: shift(c.start), end: shift(c.end) }))
  return planAssembly({ segments, cuts, duration: dur })
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
