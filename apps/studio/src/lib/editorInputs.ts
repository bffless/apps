/**
 * The Build page's CutEditor inputs, derived per SELECTED scene from the
 * multi-source project (story 09). Scene `start`/`end` are LOCAL to the scene's
 * own source, so numerically identical windows exist on every source — every
 * scene-scoped input (words, audio, silence map) MUST come from the scene's own
 * source, never the legacy top-level fields (which only mirror the primary
 * source; feeding those in blanked chapters whose window lies past the primary
 * source's last word, and silently showed the primary's words under everything
 * else).
 *
 * The whole-project readout inputs (`duration`, `projectCuts`) get the opposite
 * treatment: cuts are lifted onto the ONE global timeline (`localToGlobal`), so
 * `finalCutSeconds`' normalize-and-subtract can't merge same-numbered spans
 * from different sources, and `duration` is all footage, not the first file's.
 *
 * Pure + deterministic — the page memoizes one call; the component just renders.
 */

import type { Scene } from './scenes'
import type { TWord, CutSpan } from './transcriptGrid'
import type { DeadSpan } from './deadSpace'
import { sceneWordsLookup } from './describe'
import { sourceForScene, totalDuration, localToGlobal } from './sources'
import { effectiveCuts } from './refiner'

/** The slice's `VideoSource`, reduced to what the editor derivations read. */
export type EditorSourceLike = {
  id: string
  /** Sequence in the final cut — the global-timeline offset follows this. */
  order: number
  duration: number
  words?: TWord[]
  audioUrl?: string | null
  deadSpace?: DeadSpan[] | null
}

export type CutEditorInputs = {
  /** The selected scene's own source's words overlapping its window. */
  words: TWord[]
  /** Whether the selected scene's source has a transcript at all — the editor's
   *  words gate. Source-level (not window-level) so an all-silent window still
   *  opens for cutting. */
  transcribed: boolean
  /** The selected scene's source audio (16 kHz WAV) for the play gutter. */
  originalAudioUrl?: string
  /** The selected scene's source silence map (story 13c). */
  deadSpace?: DeadSpan[]
  /** ALL footage, in seconds — every source, for the header readout. */
  duration: number
  /** Every scene's effective cuts on the GLOBAL timeline, for the readout. */
  projectCuts: CutSpan[]
}

export function cutEditorInputs(
  sources: EditorSourceLike[],
  scenes: Scene[],
  selected: Scene | null,
): CutEditorInputs {
  const ordered = [...sources].sort((a, b) => a.order - b.order)
  const source = selected ? sourceForScene(ordered, selected) : null
  const words = selected && source ? sceneWordsLookup([source])(selected) : []

  const projectCuts = scenes.flatMap((s) => {
    const offset = localToGlobal(ordered, s.sourceId, 0) ?? 0
    return effectiveCuts(s).map((c) => ({ start: c.start + offset, end: c.end + offset }))
  })

  return {
    words,
    transcribed: (source?.words?.length ?? 0) > 0,
    originalAudioUrl: source?.audioUrl ?? undefined,
    deadSpace: source?.deadSpace ?? undefined,
    duration: totalDuration(ordered),
    projectCuts,
  }
}
