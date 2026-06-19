/**
 * The ffmpeg.wasm executor (story 05) — the dumb runtime half of assemble.
 *
 * Everything clever (the timeline walk, the filter graph) is the pure
 * `./assemble.ts`; this module just loads the wasm core and runs the argv it
 * produced. Two deliberate choices:
 *
 *  - **Lazy.** `@ffmpeg/ffmpeg` is dynamically imported on first `assemble()`,
 *    never at module load — so its worker + glue stay out of the initial JS the
 *    page evaluates. The ~32 MB wasm core is a bundled asset (`?url` below) the
 *    browser only fetches when `load()` runs, not on page load.
 *  - **Multithreaded when the page allows it.** On a cross-origin-isolated page
 *    (COOP/COEP headers → `SharedArrayBuffer`) we load `@ffmpeg/core-mt`; anywhere
 *    else (e.g. `npm run dev`) we fall back to single-threaded `@ffmpeg/core`.
 *    Mind the heaps: the MT core's shared memory is FIXED at load (no growth) —
 *    its build default of 1 GiB OOMed real scene assembles, so
 *    `scripts/patch-core-mt.mjs` raises it to 3 GiB on postinstall. The ST core
 *    grows on demand up to 2 GiB. Errors below name the core that ran.
 *
 * **Why the ESM core, served locally.** `@ffmpeg/ffmpeg` runs in a *module* worker
 * (`type: "module"`), where `importScripts` doesn't exist — so it loads the core
 * via `await import(coreURL)`, which needs the ESM build's `export default`. We
 * resolve both the core JS and the wasm through Vite's `?url` so they're bundled
 * from the npm package as ordinary hashed assets — no CDN fetch at runtime.
 */

import type { FFmpeg } from '@ffmpeg/ffmpeg'
// Resolved by Vite from the installed @ffmpeg/core* packages (their `exports` maps
// point `.`/`./wasm`/`./worker` at the ESM build). `?url` emits them as static
// assets and hands back their served URLs — bundled locally, fetched on first
// load only, and only the variant actually chosen below is ever fetched.
import coreUrl from '@ffmpeg/core?url'
import wasmUrl from '@ffmpeg/core/wasm?url'
// Multithreaded core (story 03g follow-up). Parallelizes the encode across CPU
// cores — the slice/assemble speed win — but needs SharedArrayBuffer, hence a
// cross-origin-isolated page (COOP/COEP) and its extra pthread `worker.js`.
import coreMtUrl from '@ffmpeg/core-mt?url'
import wasmMtUrl from '@ffmpeg/core-mt/wasm?url'
import workerMtUrl from '@ffmpeg/core-mt/worker?url'

const abs = (u: string) => new URL(u, window.location.href).href

// One core instance for the session — loading it is expensive, running is reusable.
let instance: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null
/** Which core actually loaded, for diagnostics. */
export let coreVariant: 'mt' | 'st' | null = null

/** Human-readable core tag for error messages ("which build OOMed?"). */
const coreLabel = () =>
  coreVariant === 'mt' ? 'multithreaded core' : coreVariant === 'st' ? 'single-threaded core' : 'core not loaded'

/**
 * Load the ffmpeg core, preferring the **multithreaded** build when the page is
 * cross-origin isolated (COOP/COEP set → `SharedArrayBuffer` available). The MT
 * core parallelizes encoding across cores, which is the slice/assemble speedup.
 *
 * This is best-effort and **never fatal**: if the page isn't isolated, or the MT
 * core fails to load for any reason (bundling quirk, missing headers, an old
 * browser), we fall back to the single-threaded core — which needs no special
 * headers and is exactly today's behavior. A fresh `FFmpeg` is used for the
 * fallback because a failed `load()` leaves its worker in an unusable state.
 */
async function getFFmpeg(): Promise<FFmpeg> {
  if (instance?.loaded) return instance
  if (loading) return loading
  loading = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')

    if (globalThis.crossOriginIsolated) {
      try {
        const ff = new FFmpeg()
        await ff.load({
          coreURL: abs(coreMtUrl),
          wasmURL: abs(wasmMtUrl),
          workerURL: abs(workerMtUrl),
        })
        instance = ff
        coreVariant = 'mt'
        console.info('[studio] ffmpeg core: multithreaded (3 GiB fixed heap)')
        return ff
      } catch (e) {
        // Fall through to the single-threaded core below — but say why, loudly.
        // A silent fallback here once masked the real story: an isolated page
        // quietly running single-threaded because the MT load threw (e.g. the
        // browser refusing the big up-front SharedArrayBuffer allocation).
        console.warn('[studio] multithreaded ffmpeg core failed to load; falling back to single-threaded:', e)
      }
    }

    const ff = new FFmpeg()
    await ff.load({ coreURL: abs(coreUrl), wasmURL: abs(wasmUrl) })
    instance = ff
    coreVariant = 'st'
    console.info('[studio] ffmpeg core: single-threaded (grows to 2 GiB)')
    return ff
  })()
  try {
    return await loading
  } finally {
    loading = null
  }
}

export type AssembleAssets = {
  /** The source video bytes (written as the command's input 0, e.g. `source.mp4`). */
  source: Uint8Array
  /** One WAV per `command.audioInputs` entry, in that order (`a0.wav`, `a1.wav`…). */
  clips: Uint8Array[]
  command: import('./assemble').FfmpegCommand
  /** 0–1 encode progress from ffmpeg's `progress` event. */
  onProgress?: (progress: number) => void
  /** Raw ffmpeg log lines, for surfacing the real error on failure. */
  onLog?: (line: string) => void
}

/**
 * Run one assemble: stage the source + clips into the wasm FS, exec the command,
 * read back `out.mp4`, and clean up. Returns the finished MP4 as a Blob. Throws
 * with ffmpeg's last log lines attached if the exec fails.
 */
export async function assemble({
  source,
  clips,
  command,
  onProgress,
  onLog,
}: AssembleAssets): Promise<Blob> {
  const ff = await getFFmpeg()

  const tail: string[] = []
  const onLogEvent = ({ message }: { message: string }) => {
    tail.push(message)
    if (tail.length > 40) tail.shift()
    onLog?.(message)
  }
  const onProgressEvent = ({ progress }: { progress: number }) => {
    // ffmpeg can briefly report >1 or <0 near the end; clamp for the bar.
    onProgress?.(Math.min(1, Math.max(0, progress)))
  }
  ff.on('log', onLogEvent)
  ff.on('progress', onProgressEvent)

  const sourceName = command.args[1] // argv is ['-i', source, ...]
  const written: string[] = []
  try {
    await ff.writeFile(sourceName, source)
    written.push(sourceName)
    for (let i = 0; i < clips.length; i++) {
      const name = `a${i}.wav`
      await ff.writeFile(name, clips[i])
      written.push(name)
    }

    const code = await ff.exec(command.args)
    if (code !== 0) {
      throw new Error(`ffmpeg exited ${code} (${coreLabel()})\n${tail.slice(-12).join('\n')}`)
    }

    const output = command.args[command.args.length - 1]
    const data = await ff.readFile(output)
    written.push(output)
    if (typeof data === 'string') throw new Error('ffmpeg returned text, expected binary output')
    // Copy into a fresh buffer — the FS-backed view is invalidated by deleteFile.
    return new Blob([data.slice()], { type: 'video/mp4' })
  } finally {
    ff.off('log', onLogEvent)
    ff.off('progress', onProgressEvent)
    for (const name of written) await ff.deleteFile(name).catch(() => {})
  }
}

export type MeasureAssets = {
  /** The narration clip to measure (written as `command.input`). */
  clip: Uint8Array
  command: { args: string[]; input: string }
  /** Raw ffmpeg log lines (the loudnorm JSON arrives here). */
  onLog?: (line: string) => void
}

/**
 * Loudnorm pass 1 (story 05 audio polish follow-up): decode one narration clip
 * through loudnorm's measurement mode and return the log lines, which carry the
 * stats JSON (`parseLoudnorm` in ./assemble.ts extracts it). Audio-only decode
 * into the null muxer — quick even single-threaded. Throws on a non-zero exit;
 * the caller treats that clip as unmeasured (single-pass fallback), so a bad
 * clip degrades the polish instead of failing the render.
 */
export async function measureLoudness({ clip, command, onLog }: MeasureAssets): Promise<string[]> {
  const ff = await getFFmpeg()

  const lines: string[] = []
  const onLogEvent = ({ message }: { message: string }) => {
    if (lines.length < 200) lines.push(message)
    onLog?.(message)
  }
  ff.on('log', onLogEvent)

  const written: string[] = []
  try {
    // writeFile TRANSFERS the buffer to the worker, detaching it on this
    // thread. Measurement is a side-read — hand over a copy so the caller can
    // still write these same bytes in the assemble that follows ("attempting
    // to access detached ArrayBuffer" otherwise).
    await ff.writeFile(command.input, clip.slice())
    written.push(command.input)

    const code = await ff.exec(command.args)
    if (code !== 0) {
      throw new Error(`ffmpeg exited ${code} (${coreLabel()})\n${lines.slice(-12).join('\n')}`)
    }
    return lines
  } finally {
    ff.off('log', onLogEvent)
    for (const name of written) await ff.deleteFile(name).catch(() => {})
  }
}

export type SliceAssets = {
  /** The source video bytes (written as the command's input). */
  source: Uint8Array
  command: import('./slice').SliceCommand
  /** 0–1 encode progress from ffmpeg's `progress` event. */
  onProgress?: (progress: number) => void
  /** Raw ffmpeg log lines, for surfacing the real error on failure. */
  onLog?: (line: string) => void
}

/**
 * Cut one scene's clip out of the source (story 03g). Stage the source into the
 * wasm FS, exec the trim argv `./slice.ts` produced, read back the clip, clean up.
 * Returns the scene clip as a Blob. Throws with ffmpeg's last log lines on failure.
 * A single short re-encode (per scene), not the whole-timeline assemble.
 */
export async function slice({ source, command, onProgress, onLog }: SliceAssets): Promise<Blob> {
  const ff = await getFFmpeg()

  const tail: string[] = []
  const onLogEvent = ({ message }: { message: string }) => {
    tail.push(message)
    if (tail.length > 40) tail.shift()
    onLog?.(message)
  }
  const onProgressEvent = ({ progress }: { progress: number }) => {
    onProgress?.(Math.min(1, Math.max(0, progress)))
  }
  ff.on('log', onLogEvent)
  ff.on('progress', onProgressEvent)

  const written: string[] = []
  try {
    await ff.writeFile(command.source, source)
    written.push(command.source)

    const code = await ff.exec(command.args)
    if (code !== 0) {
      throw new Error(`ffmpeg exited ${code} (${coreLabel()})\n${tail.slice(-12).join('\n')}`)
    }

    const data = await ff.readFile(command.output)
    written.push(command.output)
    if (typeof data === 'string') throw new Error('ffmpeg returned text, expected binary output')
    return new Blob([data.slice()], { type: 'video/mp4' })
  } finally {
    ff.off('log', onLogEvent)
    ff.off('progress', onProgressEvent)
    for (const name of written) await ff.deleteFile(name).catch(() => {})
  }
}

export type ConcatAssets = {
  /** Each per-scene MP4 to join, in order: the FS name + its bytes. */
  parts: { name: string; bytes: Uint8Array }[]
  command: import('./assemble').ConcatCommand
  onLog?: (line: string) => void
}

/**
 * Stream-copy concat of the per-scene MP4s into the final cut (story 03g phase 2).
 * Writes each scene MP4 + the concat list file into the wasm FS, runs the `-c copy`
 * join (no re-encode → fast, minimal memory), reads back the result, cleans up.
 */
export async function concat({ parts, command, onLog }: ConcatAssets): Promise<Blob> {
  const ff = await getFFmpeg()

  const tail: string[] = []
  const onLogEvent = ({ message }: { message: string }) => {
    tail.push(message)
    if (tail.length > 40) tail.shift()
    onLog?.(message)
  }
  ff.on('log', onLogEvent)

  const written: string[] = []
  try {
    for (const part of parts) {
      await ff.writeFile(part.name, part.bytes)
      written.push(part.name)
    }
    await ff.writeFile(command.listName, command.listContent)
    written.push(command.listName)

    const code = await ff.exec(command.args)
    if (code !== 0) {
      throw new Error(`ffmpeg exited ${code} (${coreLabel()})\n${tail.slice(-12).join('\n')}`)
    }

    const data = await ff.readFile(command.output)
    written.push(command.output)
    if (typeof data === 'string') throw new Error('ffmpeg returned text, expected binary output')
    return new Blob([data.slice()], { type: 'video/mp4' })
  } finally {
    ff.off('log', onLogEvent)
    for (const name of written) await ff.deleteFile(name).catch(() => {})
  }
}
