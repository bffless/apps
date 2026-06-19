/**
 * Headless scene/final assemble (story 03s). The render logic that used to live
 * inside SceneAssembleBar/FinalCutBar's `run()` callbacks, lifted here so BOTH the
 * manual bars AND the auto-build orchestrator drive the exact same ffmpeg.wasm
 * walk. Pure orchestration over the existing `src/lib/export/*` primitives — it
 * takes a byte-fetcher (the signed-bytes reader) and returns the rendered Blob.
 * Throws on any failure so callers can surface/halt.
 */

import type { Scene } from '../scenes'
import { effectiveCuts, effectiveSegments, overlaps } from '../refiner'
import {
  planScene,
  buildFfmpegCommand,
  buildMeasureCommand,
  buildConcatCommand,
  parseLoudnorm,
  LOUDNORM_ENABLED,
  type LoudnormStats,
} from './assemble'
import { assemble, measureLoudness, concat } from './ffmpeg'

/** Reads a serve path's bytes (signing big objects straight to the bucket). */
export type FetchBytes = (url: string) => Promise<Uint8Array>

/** Render ONE scene off its own cut clip — cuts dropped, narration over kept
 *  video, dead space silent. Mirrors SceneAssembleBar.run(). */
export async function assembleSceneBlob({
  scene,
  fetchBytes,
  onStage,
  onProgress,
}: {
  scene: Scene
  fetchBytes: FetchBytes
  onStage?: (msg: string) => void
  onProgress?: (fraction: number) => void
}): Promise<Blob> {
  if (!scene.clipUrl) throw new Error("Cut this scene first — assemble works on the scene's own clip.")
  const segments = effectiveSegments(scene)
  if (overlaps(segments).length > 0)
    throw new Error('Resolve overlapping narration runs before assembling this scene.')
  const plan = planScene({ segments, cuts: effectiveCuts(scene), start: scene.start, end: scene.end })
  if (plan.video.length === 0) throw new Error('Nothing to assemble — the whole scene is cut.')

  const draft = buildFfmpegCommand(plan, { source: 'clip.mp4', output: 'scene.mp4' })

  onStage?.('Loading the scene clip…')
  const source = await fetchBytes(scene.clipUrl)

  onStage?.(`Gathering ${draft.audioInputs.length} narration clip${draft.audioInputs.length === 1 ? '' : 's'}…`)
  const clips = await Promise.all(
    draft.audioInputs.map((segIndex) => {
      const url = segments[segIndex]?.audioUrl
      if (!url) throw new Error(`Segment ${segIndex} has no audio to assemble.`)
      return fetchBytes(url)
    }),
  )

  const loudness: (LoudnormStats | null)[] = []
  if (LOUDNORM_ENABLED) {
    for (let k = 0; k < clips.length; k++) {
      onStage?.(`Measuring narration loudness (${k + 1}/${clips.length})…`)
      loudness.push(
        await measureLoudness({ clip: clips[k], command: buildMeasureCommand(`m${k}.wav`) })
          .then(parseLoudnorm)
          .catch(() => null),
      )
    }
  }

  const command = buildFfmpegCommand(plan, { source: 'clip.mp4', output: 'scene.mp4', loudness })
  onStage?.('Assembling this scene…')
  return assemble({ source, clips, command, onProgress })
}

/** Stitch every scene's saved assembled cut into the whole video (stream-copy
 *  concat). Mirrors FinalCutBar.run(). */
export async function assembleFinalCutBlob({
  scenes,
  fetchBytes,
  onStage,
}: {
  scenes: Scene[]
  fetchBytes: FetchBytes
  onStage?: (msg: string) => void
}): Promise<Blob> {
  onStage?.(`Gathering ${scenes.length} assembled scene${scenes.length === 1 ? '' : 's'}…`)
  const parts = await Promise.all(
    scenes.map(async (s, i) => {
      if (!s.assembledUrl) throw new Error(`Scene ${i + 1} isn't assembled yet.`)
      return { name: `scene-${i}.mp4`, bytes: await fetchBytes(s.assembledUrl) }
    }),
  )

  if (parts.length === 1) return new Blob([parts[0].bytes.slice()], { type: 'video/mp4' })

  onStage?.('Stitching the final cut…')
  const command = buildConcatCommand(parts.map((p) => p.name))
  return concat({ parts, command })
}
