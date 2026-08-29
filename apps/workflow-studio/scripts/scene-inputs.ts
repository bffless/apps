/**
 * `scene-inputs` — `per-scene` → step `inputs`.
 *
 *   with:    { scene, words, scenes }
 *   outputs: { word_timings, previous_context, scene_words }   (R130 names)
 *
 * The `refine-scene` pipeline wants three things Studio derived from its store:
 * the scene's own words as `start end word` lines, the tail of the previous
 * scene's kept speech (so cut decisions at the seam aren't made blind), and the
 * word list itself — which the cut-editor island also renders. All three come
 * from Studio's own helpers; nothing is re-implemented here.
 *
 * `words` is THIS scene's source's full WhisperX list — `needs.per-video.outputs.words[scene.sourceIndex]`
 * — so the window slice happens here rather than in an expression.
 */
import type { ScriptContext } from '@bffless/workflow-script'
import { sceneTail, sceneWordTimings } from 'studio/lib/refiner'
import type { TWord } from 'studio/lib/transcriptGrid'
import { requireSceneRows, requireWords, toScene, toSceneRow, type SceneRow } from './lib/inputs'

const NAME = 'scene-inputs'

/** The words a scene owns: midpoint inside `[start, end)`. The same rule
 *  `keptWords` uses to decide whether a cut swallows a word, so a word is never
 *  claimed by two scenes nor counted in one scene and cut in another. */
function wordsInWindow(words: TWord[], scene: Pick<SceneRow, 'start' | 'end'>): TWord[] {
  return words.filter((w) => {
    const mid = (w.start + w.end) / 2
    return mid >= scene.start && mid < scene.end
  })
}

export default async function sceneInputs(ctx: ScriptContext): Promise<Record<string, unknown>> {
  const scene = toSceneRow(NAME, 'scene', ctx.inputs.scene)
  const words = requireWords(NAME, ctx.inputs, 'words')
  const scenes = requireSceneRows(NAME, ctx.inputs, 'scenes')

  const sceneWords = wordsInWindow(words, scene)

  const previous = scenes.find((s) => s.number === scene.number - 1)
  // The previous row's words are only in hand when it came out of the SAME
  // recording — `words` is one source's list, and the workflow passes the list for
  // THIS scene's `sourceIndex`. Across a source boundary we pass `[]` so `sceneTail`
  // falls back to the row's own `transcript`, which is `''` unless a legacy director
  // row echoed the words back (the 13f contract does not) — an empty lead-in, which
  // is what the refiner already gets for scene 1.
  const previousWords =
    previous && previous.sourceIndex === scene.sourceIndex ? wordsInWindow(words, previous) : []
  // `sceneTail` applies the previous row's `effectiveCuts` (its director baseline
  // `cuts`) through `keptWords` before taking the last 30 words, so a cut word never
  // shows up in the lead-in.
  const previousContext = previous ? sceneTail(toScene(previous), previousWords) : ''

  ctx.log(
    `${sceneWords.length} words in scene ${scene.number}` +
      (previousContext ? `; ${previousContext.split(' ').length}-word lead-in` : ''),
  )

  return {
    word_timings: sceneWordTimings(sceneWords),
    previous_context: previousContext,
    scene_words: sceneWords,
  }
}
