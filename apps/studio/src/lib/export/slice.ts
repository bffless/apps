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
 * the video. Re-encoding (`-ss` before `-i` for a fast accurate seek, then `-t`
 * for the span) rebuilds clean timestamps from `t=0` and keeps both tracks the
 * same length — so the clip is seekable from its first frame and clip-local
 * rebasing downstream is a plain `−scene.start`. The encode runs per scene on a
 * short span (never the whole timeline); it is slow in single-threaded wasm —
 * speeding it up is the multithreaded-ffmpeg follow-up, not a stream-copy hack.
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
  // Clamp to a sane span: start ≥ 0 and end strictly after it, so the argv never
  // asks ffmpeg for a zero/negative duration even if a scene's bounds are degenerate.
  const start = Math.max(0, opts.start)
  const end = Math.max(start, opts.end)
  const dur = end - start

  const args = [
    // `-ss` before `-i` = fast seek; re-encode makes it frame-accurate from t=0.
    '-ss',
    secs(start),
    '-i',
    source,
    '-t',
    secs(dur),
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
