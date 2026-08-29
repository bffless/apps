/**
 * `final-script` — `stitch` → step `script`.
 *
 *   with:    { scenes, keep, words }
 *   outputs: { script, chapters }
 *
 * What the finished short actually says, and where its chapters fall. The edit is
 * cut-first (ADR-0003): nothing is re-voiced, so the script IS the original speech
 * that survives the cuts, and a chapter starts at the cumulative KEPT length of the
 * scenes before it — not at any source timestamp. `describe.ts` owns both
 * derivations (`videoScript`, `videoChapters`/`formatChapters`); this step's job is
 * to rebuild the `Scene` objects they read from three parallel lists.
 *
 * The three inputs are in `needs.director.outputs.scenes` order:
 * - `scenes` — the director rows (`start`/`end` LOCAL to each row's own source).
 * - `keep`   — what the cut editor kept, in CLIP-relative seconds: the scene's clip
 *              was sliced as `[scene.start, scene.end]`, so clip 0 IS `scene.start`.
 * - `words`  — each scene's `scene_words` from `scene-inputs`, in SOURCE seconds.
 *
 * Studio stored cuts, not keeps, so `keep` is inverted back into cuts before the
 * helpers see it — `keptSpans` already computes exactly that complement (it is the
 * same function run the other way round), which keeps the 0.05s sliver tolerance
 * identical in both directions.
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { formatChapters, videoChapters, videoScript, type SceneWords } from 'studio/lib/describe'
import { keptSpans } from 'studio/lib/refiner'
import type { Cut, Scene } from 'studio/lib/scenes'
import type { TWord } from 'studio/lib/transcriptGrid'
import { requireArray, requireSceneRows, toScene, toWords, inputError, type SceneRow } from './lib/inputs'

const NAME = 'final-script'

/** One scene's kept spans, clip-relative, as the cut editor emits them. */
function keptFor(value: unknown, index: number): Cut[] {
  if (!Array.isArray(value)) throw inputError(NAME, 'keep', `must be a list of span lists (entry ${index} is not a list)`)
  return value.map((s) => {
    if (
      typeof s !== 'object' || s === null ||
      typeof (s as Cut).start !== 'number' || typeof (s as Cut).end !== 'number'
    ) {
      throw inputError(NAME, 'keep', `must be a list of \`{ start, end }\` spans (entry ${index})`)
    }
    return { start: (s as Cut).start, end: (s as Cut).end }
  })
}

/** The cuts that produce `keep`: the complement of the kept spans inside the scene
 *  window, with the clip-relative spans first mapped back to source seconds. */
function cutsFor(row: SceneRow, keep: Cut[]): Cut[] {
  return keptSpans(
    keep.map((k) => ({ start: k.start + row.start, end: k.end + row.start })),
    row.start,
    row.end,
  )
}

export default async function finalScript(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const rows = requireSceneRows(NAME, ctx.inputs, 'scenes')
  const keep = requireArray(NAME, ctx.inputs, 'keep')
  const words = requireArray(NAME, ctx.inputs, 'words')

  // `scenes` is the matrix the other two lists were produced over, so a length
  // mismatch means a scene failed and its outputs never landed — pairing by index
  // past that point would attribute one scene's words to another.
  if (keep.length !== rows.length || words.length !== rows.length) {
    throw inputError(
      NAME,
      keep.length !== rows.length ? 'keep' : 'words',
      `must have one entry per scene (${rows.length}); got ${keep.length !== rows.length ? keep.length : words.length}`,
    )
  }

  // Identity lookup: `videoScript`/`scriptWords` hand `wordsFor` the very objects
  // from this array, so no `sourceId` bookkeeping is needed (and two scenes from
  // the same recording keep their own word lists).
  const byScene = new Map<Scene, TWord[]>()
  const scenes: Scene[] = rows.map((row, i) => {
    const scene = toScene(row, cutsFor(row, keptFor(keep[i], i)))
    byScene.set(scene, toWords(NAME, 'words', words[i]))
    return scene
  })
  const wordsFor: SceneWords = (scene) => byScene.get(scene) ?? []

  const script = videoScript(scenes, wordsFor)
  const chapters = formatChapters(videoChapters(scenes))
  ctx.log(`${scenes.length} chapters, ${script ? script.split(/\s+/).length : 0} spoken words`)
  return { script, chapters }
}
