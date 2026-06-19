# 03k — scene audio → refiner (audio-aware cuts)

> Read `00-architecture-and-state.md` first.

**Status:** ✅ shipped (FE + rule `afacb572` prep/signAudio/audio-input/prompt; pre-edit
backup + payload in `.bffless-backups/*-03k*`) — live-Gemini effect (does it dodge the
cough?) deferred until a real cut+refine runs, same as 03j. Note: the server enforces
the missing-`audioUrl` rejection as a `prep` throw → **500 `EXECUTION_ERROR`** (verified
by curl, no job enqueued); the MSW mock's 400 is the same contract with a stricter status.

## Why

The refiner is **deaf**. It places segments and cuts from three inputs — the
timestamped transcript, the director's first pass, and the dense contact sheets —
and none of them carry what the audio actually *sounds like* between the words.
WhisperX is trained on "intended transcription" data, so it deliberately omits
non-speech (no parameter changes that); the sheets only show the visuals.

Real failure that motivated this: a refined scene was great **except it opened on
a cough**. With ears, the refiner would have nudged the cut boundary a beat
later. And it's not just coughs — it's anything that breaks the natural flow:
yelling at the dog, a throat clear, an off-script interruption, a restart. Today
those land inside kept segments (and inside `original`-tagged spans, where the
slice plays *everything*).

## Design decisions (from the brainstorm, 2026-06-11)

- **The scene's audio is cut at the same moment as its video.** Step 0 ("Cut
  this scene") produces **two resources**: the existing video clip
  (`scene.clipUrl`) and a new scene-span WAV (`scene.clipAudioUrl`). Rejected
  alternatives: passing the video clip to Gemini as a `videos` input (duplicates
  the sheets at higher token cost; mp4 ≫ mono WAV) and signing the whole-talk
  WAV with a "look only at this window" prompt (cost scales with the full talk;
  attention drift; explicitly ruled out — never send the full raw file).
- **Refine requires the cut.** The Refine button gates on `clipAudioUrl` the
  same way it already gates on sheets — one prompt path server-side, no silent
  fallback to the old deaf behavior. Scenes cut before 03k need one Re-cut.
- **Response shape unchanged.** `segments` + `cuts` already express everything
  the audio teaches: nudging a boundary = different `start`/`end`; junk
  mid-segment = split into two segments with the junk in the gap / under a cut.
  `toRefinement` and the 03j verbatim guard work untouched (a split around a
  cough still matches its span's words — coughs aren't words).
- **The prompt rule is flow-general, not a cough list.** "Anything that doesn't
  belong in the final cut" — coughs are an example, not the spec.
- **The prompt must state the offset mapping.** The scene WAV starts at 0:00 but
  transcript/segments/cuts use original-timeline seconds; without "audio 0:00 =
  `{start}`s" every audio-informed boundary would shift by `scene.start`.

## Data model (`src/lib/scenes.ts` — optional, no migration)

```ts
type Scene = {
  // NEW — serve path of this scene's span sliced from the talk WAV, uploaded at
  // cut time alongside clipUrl. URL-only (no blobs in Redux/localStorage).
  clipAudioUrl?: string
}
```

## Cut step changes (`useScenePipeline.sliceScene`)

- After the ffmpeg.wasm video trim + upload, slice the same span from the
  already-uploaded talk WAV with the existing `sliceAudioWav(audioUrl,
  scene.start, scene.end)` and upload it (presigned flow, `kind: 'audio'`,
  named `scene-<n>-audio.wav`).
- **Uploads run sequentially** (the Vite-proxy keep-alive 502 lesson).
- **Both-or-neither:** one `patchScene` at the end writes `clipUrl` +
  `clipAudioUrl` together. Any failure (no talk WAV, slice error, upload error)
  fails the whole cut step with a stage error — re-cut redoes both. Re-cut
  overwrites both.

## Refine changes (`refiner.ts` + `useScenePipeline.refineScene` + `SceneRefinePanel`)

- `RefineSceneRequest` gains a **required** `audioUrl: string` — the scene-audio
  serve path; `refineScene` passes `scene.clipAudioUrl`.
- `SceneRefinePanel`: Refine disabled until the scene is cut (alongside the
  existing sheets gate), with a "Cut this scene first" title hint. Pre-03k
  scenes show the hint until a Re-cut.

## Pipeline changes (`/api/refine-scene`, rule `afacb572` — bffless-pipeline skill)

- Request schema adds `audioUrl` (required).
- The async post-steps (03f Part 0) **sign it exactly like the sheet URLs** and
  pass the signed URL as the Gemini `audio` input (Replicate's Gemini accepts
  one audio file alongside `images`).
- Prompt additions (two):
  1. **Offset mapping** — "the attached audio is this scene's soundtrack; audio
     0:00 corresponds to `{start}`s on the timeline your transcript, segments,
     and cuts use."
  2. **Flow rule** — use the audio to align cut and segment boundaries to the
     natural flow of speech. Anything that doesn't belong in the final cut —
     coughs, shouts, interruptions, off-script noises, restarts — must not
     start, end, or sit inside a kept segment: nudge the boundary to exclude
     it, or split the segment around it and cover the junk with a cut. Never
     tag a span `original` if it contains such a sound.

## Mock (`src/mocks/handlers.ts` — mock-first, before any pipeline edit)

- The `/api/refine-scene` handler validates `audioUrl` is present (400 if
  missing, mirroring the server schema) and returns the same fixture — the
  response shape is unchanged, so mock and real keep coercing through the one
  `toRefinement`.

## Acceptance criteria

- [x] Cutting a scene uploads + persists both `clipUrl` and `clipAudioUrl`
      (sequential uploads, both-or-neither patch); re-cut overwrites both.
- [x] Refine is disabled without `clipAudioUrl` (hint shown, RTL-tested) and the
      request carries `audioUrl`; the MSW mock rejects a missing `audioUrl`.
- [x] Rule `afacb572` signs the scene audio and passes it as the Gemini `audio`
      input; prompt carries the offset mapping + the flow-general rule.
      _(missing-`audioUrl` rejection curl-verified — `prep` throws before
      `createJob`, so nothing is enqueued and no credits are spent)_
- [x] Non-destructive invariants hold: director `draftText`/`cuts` untouched;
      `toRefinement` + 03j verbatim guard unchanged (zero edits to either);
      revert still = clear `refined`.
- [x] `npm run build` / `npm run lint` / `npm run test:run` pass. _(lint: zero
      findings in 03k files; the two pre-existing `ChatPanel.tsx` errors are the
      known 03i-era debt, unchanged)_
- [ ] ⚠️ Live-Gemini effect (does it actually dodge the cough?) needs a real
      cut+refine with the Replicate token — same deferral as 03j; the code-level
      done bar is the items above.

## Out of scope

- An explicit `nonSpeechEvents[]` response field / hazard markers on the diff
  grid — only add if prompt-level cut alignment proves insufficient.
- Giving the **master director** audio (it stays whole-talk, sheets + transcript
  only; audio context is the refiner's job, scene-scoped and cheap).
- Switching transcription models (WhisperX stays the word-timestamp source of
  truth).
- Inter-word-gap heuristics client-side (trim "use original" slices around big
  gaps) — a separate, model-free idea; park it unless live results disappoint.
- Validators (`auth_required`/`rate_limit`) — still story 07.
