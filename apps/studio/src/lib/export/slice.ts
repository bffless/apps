/**
 * Slice — the pure ffmpeg argv for cutting one scene's clip out of the source
 * (story 03g, the "Cut this scene" build step).
 *
 * The raw recording is the immutable source of truth; this builds the command
 * that copies just a scene's `[start, end]` span into its own small MP4, which is
 * then uploaded and persisted on the scene (`Scene.clipUrl`). Every downstream
 * step (the Build preview, the per-scene assemble) works on that small clip
 * instead of dragging the whole film through ffmpeg.
 *
 * **Re-encode, not stream-copy.** We tried `-c copy` for speed and it produced
 * broken clips: stream-copy can only begin on a keyframe, so ffmpeg writes an MP4
 * edit list that makes the player start partway in and refuse to seek to 0, and
 * the independent audio/video packet-boundary cut leaves the audio ending before
 * the video. Re-encoding rebuilds clean timestamps from `t=0`, so the clip is
 * seekable from its first frame and clip-local rebasing downstream is a plain
 * `−scene.start`. The encode runs per scene on a short span (never the whole
 * timeline); it is slow in single-threaded wasm — speeding it up is the
 * multithreaded-ffmpeg follow-up, not a stream-copy hack.
 *
 * **Why a filter graph and not a bare `-ss`/`-t`.** A plain `-ss`+re-encode cuts
 * the two streams on different grids: video can only begin on a whole frame, so
 * ffmpeg keeps the first frame at/after `start`, while audio begins on the exact
 * sample. It then zeroes both — silently discarding the sub-frame gap on the video
 * side alone, so the clip's picture runs up to `1/fps` AHEAD of its sound (33 ms at
 * 30 fps: visible lip sync error, and it survives every downstream step). Instead
 * we fast-seek with `-ss` for speed, keep the demuxer's absolute timestamps with
 * `-copyts` so the filter can address original-video seconds, and `trim`/`atrim`
 * both streams against **one shared origin** (`PTS-start/TB`). The first frame keeps
 * its true offset into the clip and the tracks stay aligned to within a millisecond.
 *
 * `-fps_mode passthrough` is load-bearing: `setpts` clears the frame rate on the
 * filter link, and with nothing to inherit ffmpeg falls back to its built-in 25 fps
 * default and resamples — dropping 1 frame in 6 from 30 fps footage, and well over
 * half of a 60 fps screen recording. Passthrough keeps every frame on its own
 * timestamp. See `./assemble.ts`, which had the identical pair of bugs.
 *
 * Like `./assemble.ts` this module is **pure** (no ffmpeg import) and unit-tested;
 * the executor that runs the argv lives in `./ffmpeg.ts`.
 */

/** Trim trailing zeros off a fixed-precision seconds value for the argv. */
function secs(v: number): string {
  return Number(v.toFixed(3)).toString()
}

export type SliceCommand = {
  /** Full ffmpeg argv (input 0 is the source; output is the scene clip). */
  args: string[]
  /** Virtual-FS name the executor writes the source bytes to. */
  source: string
  /** Virtual-FS name the executor reads the finished clip back from. */
  output: string
}

/**
 * Build the ffmpeg invocation that cuts `[start, end]` out of the source into its
 * own MP4 by re-encoding. `start`/`end` are original-video seconds; the output is
 * a standalone clip whose timeline is `[0, end − start]`, seekable from frame one.
 *
 * Single-threaded-friendly (`libx264 ultrafast`, `yuv420p`, aac, faststart) — the
 * same encode profile as assemble, so the clip plays everywhere the final cut does.
 */
export function buildSliceCommand(opts: {
  start: number
  end: number
  source?: string
  output?: string
}): SliceCommand {
  const source = opts.source ?? 'source.mp4'
  const output = opts.output ?? 'clip.mp4'
  // Clamp to a sane span: start ≥ 0 and end never before it, so the argv never
  // asks ffmpeg for a negative span even if a scene's bounds are degenerate.
  const start = Math.max(0, opts.start)
  const end = Math.max(start, opts.end)
  const s = secs(start)
  const e = secs(end)

  // Both streams trim the same span and rebase to the same origin (`start`), so the
  // video's whole-frame snapping shows up as a sub-frame offset INSIDE the clip
  // rather than as a shift against the audio.
  const origin = `PTS-${s}/TB`
  const filterComplex = [
    `[0:v]trim=${s}:${e},setpts=${origin}[v]`,
    `[0:a]atrim=${s}:${e},asetpts=${origin}[a]`,
  ].join(';')

  const args = [
    // `-ss` before `-i` = fast seek (skip straight to the scene, don't decode from 0).
    '-ss',
    s,
    // Keep absolute demuxer timestamps so `trim` below speaks original-video seconds.
    '-copyts',
    '-i',
    source,
    // Under `-copyts` this is an absolute source second, not a duration. `trim` already
    // ends the streams, but `-to` stops the decoder rather than reading on to EOF.
    '-to',
    e,
    '-filter_complex',
    filterComplex,
    '-map',
    '[v]',
    '-map',
    '[a]',
    // Keep the source's frames/timestamps; without this `setpts` leaves the frame rate
    // unknown and ffmpeg resamples to its 25 fps default. See the module docstring.
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    // Same 4-thread cap as assemble: bounds x264's per-thread full-res buffers
    // inside the fixed-size wasm heap (see buildFfmpegCommand).
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
  return { args, source, output }
}
