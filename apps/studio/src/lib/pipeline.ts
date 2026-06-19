/**
 * The prep pipeline: the steps that run once on import to get the clip ready
 * for scene-by-scene production. These stage definitions ARE the "notes in the
 * browser" — shown up front, checked off as each completes. `where` marks
 * whether a step runs in the browser or in a BFFless pipeline.
 *
 * After prep, the producer builds each scene one at a time (see `scenes.ts`);
 * the final assemble/render is a separate action, not a prep stage.
 */

export type StageId =
  | 'upload'
  | 'extract'
  | 'transcribe'
  | 'thumbnails'
  | 'director'
  | 'clone'

export type StageStatus = 'pending' | 'active' | 'done' | 'error'
export type Where = 'browser' | 'pipeline' | 'browser+pipeline'

/**
 * Whether a stage runs once per source video ('video') or once for the whole
 * project ('global'). Upload, extract, and transcribe are per-video so that
 * multiple source clips can each be processed independently; thumbnails,
 * director, and clone operate across all sources and run once.
 */
export type StageScope = 'video' | 'global'

export type StageDef = {
  id: StageId
  title: string
  /** What we're going to do — the note shown before it runs. */
  note: string
  where: Where
  /** Whether this stage runs once per source video or once for the whole project. */
  scope: StageScope
  /**
   * Label for this step's manual action button. Prep runs step by step now —
   * the user triggers each real step deliberately. Steps without their own
   * label are completed as part of an earlier step's grouped action.
   */
  actionLabel?: string
}

export type Stage = StageDef & { status: StageStatus; detail?: string }

/**
 * The macro phases of the whole producer journey, shown as the top-level
 * stepper so you always know where you are. Derived purely from existing state —
 * see `studioPhase`.
 */
export type StudioPhase = 'import' | 'prep' | 'build' | 'export'

export const PHASES: { id: StudioPhase; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'prep', label: 'Prep' },
  { id: 'build', label: 'Build' },
  { id: 'export', label: 'Export' },
]

/**
 * Which macro phase the producer is in, from the current pipeline state.
 * `hasSource` is true when there's either an in-memory clip OR a persisted
 * source reference from a restored session — so the stepper reflects saved
 * progress after a hard reload, not just a freshly-attached file.
 */
export function studioPhase(s: {
  hasSource: boolean
  ready: boolean
  allBuilt: boolean
}): StudioPhase {
  if (!s.hasSource) return 'import'
  if (!s.ready) return 'prep'
  if (!s.allBuilt) return 'build'
  return 'export'
}

export const STAGE_DEFS: StageDef[] = [
  {
    id: 'upload',
    title: 'Save the clip to a bucket',
    note: 'Upload the source video to BFFless storage so the rest of the pipeline can work from it.',
    where: 'pipeline',
    scope: 'video',
    actionLabel: 'Save to bucket',
  },
  {
    id: 'extract',
    title: 'Extract & upload audio',
    note: 'Pull a 16 kHz mono WAV out of the video right here in the browser, then upload that WAV to the bucket on its own — Replicate transcribes the audio, not the video.',
    where: 'browser+pipeline',
    scope: 'video',
    actionLabel: 'Extract & upload audio',
  },
  {
    id: 'transcribe',
    title: 'Transcribe with timestamps',
    note: 'Send the uploaded audio to a Replicate speech-to-text model; get the words back with time markers.',
    where: 'pipeline',
    scope: 'video',
    actionLabel: 'Transcribe audio',
  },
  {
    id: 'thumbnails',
    title: 'Sample & save director thumbnails',
    note: 'Grab frames across the whole clip (≤30s apart), compose them into timestamped contact sheets, and upload each to the bucket — the visual context the AI director reads alongside the transcript.',
    where: 'browser+pipeline',
    scope: 'global',
    actionLabel: 'Generate thumbnails',
  },
  {
    id: 'clone',
    title: 'Clone or choose your voice',
    note: "Set the voice your scenes are narrated in: record a short sample to clone your own voice (MiniMax voice-cloning), or pick one of MiniMax's preset voices. Opens a recorder below the scenes.",
    where: 'browser+pipeline',
    scope: 'global',
    // Owned by the VoiceStudio resource, not the board runner: this button just
    // reveals it (see Studio.tsx). Recording + clone/preset happen there.
    actionLabel: 'Choose your voice',
  },
  {
    id: 'director',
    title: 'Send to the AI director',
    note: 'Hand the timestamped transcript, the director contact sheets, and the cast voice setup to the AI master director (Gemini), with any direction of your own. One call groups the talk into logical 2–5 min scenes — each with its original-video timestamps, the footage to cut, and a starting prompt to steer its refine. You get back a one-line synopsis plus your chapters.',
    where: 'pipeline',
    scope: 'global',
    // The master director (story 03): a single Gemini call does the scene
    // grouping AND writes each scene's refine prompt (story 03q) — so it's one
    // step. The action lives in the richer DirectorPanel (see panelStageId), not
    // an inline board button.
    actionLabel: 'Send to the AI director',
  },
]

/** Stage ids that run once per source video (upload → extract → transcribe). */
export const PER_VIDEO_STAGES = STAGE_DEFS.filter((s) => s.scope === 'video').map((s) => s.id)
/** Stage ids that run once for the whole project (thumbnails → clone → director). */
export const GLOBAL_STAGES = STAGE_DEFS.filter((s) => s.scope === 'global').map((s) => s.id)
