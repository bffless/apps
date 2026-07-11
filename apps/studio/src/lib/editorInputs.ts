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
import type { ContactSheet } from './frames'
import type { TWord, CutSpan } from './transcriptGrid'
import type { DeadSpan } from './deadSpace'
import { sceneWordsLookup } from './describe'
import { sourceForScene, totalDuration, localToGlobal, globalToLocal } from './sources'
import { buildFilmstrip, type FilmFrame } from './filmstrip'
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

/**
 * The filmstrip gutter's frames for the SELECTED scene, on that scene's own
 * source-local timeline — the one the editor's rows are numbered in.
 *
 * Two sheet families feed it, timed differently: a scene's own refiner sheets are
 * sampled in its source's LOCAL seconds, while the whole-project prep sheets are
 * stamped with GLOBAL concatenated time (story 09c). Flattening both into one
 * numeric index (as the page used to) mixes timelines — scenes on different
 * sources overlap numerically, so a row could resolve to a frame sampled from
 * another source's video. So: take this scene's own sheets as they are, then
 * route each prep frame back through `globalToLocal` and keep only the ones that
 * landed in this scene's source.
 *
 * The scene's dense frames come first, so a tie at the same second resolves to
 * them (the sort is stable) — the same "denser sheets win" rule `buildFilmstrip`
 * has always documented, now within one timeline. A project with no sources at
 * all (pre-story-09) or a scene whose source is gone has no global timeline to
 * unmap, so its prep times are already local and pass through untouched.
 */
export function sceneFilmstrip(
  sources: Pick<EditorSourceLike, 'id' | 'order' | 'duration'>[],
  selected: Scene | null,
  prepSheets: ContactSheet[],
): FilmFrame[] {
  if (!selected) return []
  const ordered = [...sources].sort((a, b) => a.order - b.order)
  const known = ordered.some((s) => s.id === selected.sourceId)

  const prep = buildFilmstrip(prepSheets).flatMap((frame) => {
    if (!known) return [frame]
    const local = globalToLocal(ordered, frame.time)
    if (!local || local.sourceId !== selected.sourceId) return []
    return [{ ...frame, time: local.localTime }]
  })

  return [...buildFilmstrip(selected.sheets ?? []), ...prep].sort((a, b) => a.time - b.time)
}
