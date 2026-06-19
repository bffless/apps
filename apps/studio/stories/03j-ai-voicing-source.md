# 03j — AI-suggested voicing source (original vs revoice)

> Read `00-architecture-and-state.md` first.

**Status:** ✅ shipped (FE + prompts) · prompts updated on rules `138f27fb` / `afacb572` (parse steps pass `voicing`/`source` through; verified against pre-edit backups). Live-model output verification deferred — no Replicate call was run; the client-side coercion guards make an off-spec model response safe regardless.

## Why

The original product idea: the AI rewrites/shortens the whole script and the user
re-voices it (cloned voice, TTS, or re-record). Still valid — but it leaves out a
second use case: the AI plans **edits to the original**, keeping the creator's own
audio wherever it survives the edit. Today reusing the original audio is a purely
manual flow (grab a span on the Original pane → place it in the New pane). The
AI's output shape can't even *express* "keep this part as-is": the director
returns only tightened `draftText` + `cuts`, the refiner's segments carry no
voicing info, and neither prompt asks for it.

Motivating direction (typed into the existing free-text `direction` field):
**"just cut out the ums and ahs, keep my voice"** — the right result is nearly
all-original scenes with many small cuts around the fillers, and near-zero manual
voicing work in Build.

## Design decisions (from the brainstorm, 2026-06-11)

- **Layered metadata at both altitudes**, matching the two-pass design: the
  director gives a coarse per-scene *plan*; the refiner tags each anchored
  segment. The director is never asked for exact voicing boundaries (its sparse
  whole-talk sheets make its timestamps too coarse to slice audio from).
- **Segment vocabulary is two values: `original` | `revoice`.** The AI only
  claims what it can verify from the transcript (does this text match the words
  spoken in this span?). Record-vs-TTS stays a human choice at voicing time —
  the per-segment VOICE bar (Record / ✨AI) is unchanged, no preselection.
  Segments are atomic: there is no "mixed" segment — the refiner splits until
  each run is purely one or the other.
- **Auto-adopt `original` suggestions only.** Slicing + uploading the user's own
  audio is free and exactly reproduces the manual grab→place result, so it runs
  automatically after refine. `revoice` segments never auto-voice (TTS spends
  Replicate credits; recording needs a human).
- **Scene level keeps `mixed`** — a chapter can legitimately contain both kinds
  of segments; the badge is a pre-refine forecast, not a contract.
- **Prompt-preference UI deferred.** The free-text `direction` reaches the
  director today; the prompts below are taught to honor voice-keeping
  directions. Note the refiner call still sends `direction: ''`
  (`useScenePipeline.refineScene`), so the refiner-prompt direction sentence is
  dormant until the 03f Part A handoff passes it through — same deferral as the
  scene-`voicing` context handoff. Preset/edit-style pickers fold into story
  03f Parts A–D (custom prompt).

## Data model (`src/lib/scenes.ts` — both fields optional, no migration)

```ts
type Scene = {
  // NEW — the director's coarse voicing plan for this chapter.
  //   'original' = ship this span in the creator's own audio, trims as cuts
  //   'revoice'  = tightened narration to be re-voiced (today's behavior)
  //   'mixed'    = some of both; the refiner decides where
  //   absent     = unknown (old persisted projects / old responses) — no badge
  voicing?: 'original' | 'revoice' | 'mixed'
}

type NarrationSegment = {
  // NEW — the refiner's per-segment suggestion. Pure provenance: survives user
  // overrides so revert/re-open flows can still show what the AI wanted.
  suggestedSource?: 'original' | 'revoice'
}
```

`audioSource` (`'ai' | 'recorded' | 'original'`) keeps meaning **what actually
happened** to the segment; `suggestedSource` is what the AI *wanted*. Both new
fields ride redux-persist for free.

## Director changes (`/api/scenes`, rule `138f27fb` + `director.ts` + mock)

- Output contract: each scene gains `"voicing": "original" | "revoice" | "mixed"`.
- Prompt additions (three):
  1. Define the three values and when to pick each.
  2. For `original` scenes, `draftText` MUST be the **verbatim surviving words**
     from the transcript, and removals (ums, false starts, tangents) MUST be
     expressed as `cuts` — never as rewritten text.
  3. Honor user direction about voice: e.g. "just cut the ums, keep my voice" ⇒
     mostly-`original` scenes with many small cuts.
- `toScenes` coerces unknown/missing `voicing` → `undefined` (old shape keeps
  working). `mockDirector` returns all three values so the UI path is exercised
  under `MOCK_STUDIO`. Mock and real share the shape — swap, don't rewrite.

## Refiner changes (`/api/refine-scene`, rule `afacb572` + `refiner.ts` + mock)

- Output contract: each segment gains `"source": "original" | "revoice"`. On
  the wire it's `source` (simplest for the model); `toRefinement` maps it to
  `NarrationSegment.suggestedSource` so it can't be confused with the existing
  refinement-level `source: 'ai' | 'manual'` (which is client-assigned, not in
  the wire shape).
- Prompt rules: a segment may only be tagged `original` if its `text` is **all**
  the words spoken inside its `[start, end]` anchors, verbatim — the audio slice
  plays everything in the span, so to drop a word (an um, a false start) the
  model must **split into separate segments around it**; the gap between them is
  what gets cut. The director's scene-level `voicing` plan is passed along as
  context (joins the 03f Part A handoff when that lands).
- `toRefinement` gains a **defensive downgrade**: normalize both sides
  (lowercase, strip punctuation) and require the segment's word sequence to
  equal the span's transcript word sequence; on mismatch coerce the tag to
  `revoice`. This is the guard that keeps a hallucinated tag from auto-slicing
  the wrong audio. Needs the scene's transcript words passed in — small
  signature extension, still pure + unit-tested.
- `mockRefiner` returns a mix of `original`/`revoice` segments.

## Auto-adopt (`useScenePipeline.ts` + `src/lib/audio.ts`)

When a refine job completes (the 03f Part 0 poll-done handler) and
`scene.refined` is written:

- Collect segments with `suggestedSource === 'original'` and no `audioUrl`;
  voice each through the existing adopt mechanics (slice the source WAV at the
  segment's anchors → upload `kind:'voice'` → `setSegmentAudio({ audioSource:
  'original', ... })`) — exactly as if the user had grab→placed each one.
- **Decode once, slice many.** `sliceAudioWav` fetches + decodes the whole clip
  per call; add a batch helper (decode once, slice each span) and run the
  **uploads sequentially** (the Vite-proxy keep-alive 502 lesson).
- **Per-segment failures are non-fatal**: a failed slice/upload leaves that
  segment unvoiced with the one-click chip below — never blocks the rest of the
  refine result.

## UI (deliberately small)

- **Scene badge** from `Scene.voicing` on the `SceneMeta` panel ("original" /
  "re-voice" / "partial") so the plan is visible before refining. Post-refine
  the badge derives from the real segment mix (e.g. "3 original · 2 revoice").
- **Auto-adopted segments** look exactly like manually adopted ones today
  (green span, `original` label). Nothing new to learn.
- **Unvoiced segments with `suggestedSource: 'original'`** (auto-adopt failed,
  or audio later cleared) show a one-click **"Use original"** affordance in the
  VOICE bar that calls the existing adopt path.
- **`revoice` segments: zero change.** Record / ✨AI stays as-is.

## Acceptance criteria

- [x] Director returns + persists `scene.voicing`; badge renders in Build;
      `toScenes` coercion unit-tested (invalid → undefined).
- [x] Refiner segments carry `source`; `toRefinement` maps it to
      `suggestedSource` and the verbatim-downgrade guard is unit-tested.
- [x] Refine completion auto-voices `original` segments (decode-once batch
      slice, sequential uploads); a failed segment leaves a working one-click
      "Use original" chip.
- [x] The ums-and-ahs flow works end-to-end under `MOCK_STUDIO`: direction →
      mostly-`original` scenes + cuts → refine → auto-adopted segments — no
      manual voicing needed. _(guard interaction proven by test; full manual click-through not performed)_
- [x] Non-destructive invariants hold: director `draftText`/`cuts` never
      mutated; `clearRefinement` still reverts cleanly; the revoice VOICE bar
      is unchanged.
- [x] Mock and real share both shapes (`toScenes`/`toRefinement` coerce both);
      prompts updated on rules `138f27fb` + `afacb572` (bffless-pipeline skill).
- [x] `npm run build` / `npm run lint` / `npm run test:run` pass.

## Out of scope

- Preference presets / custom-prompt UI — story 03f Parts A–D.
- Auto-TTS for `revoice` segments (never auto-spend credits).
- Per-segment record-vs-AI nudging (two-value vocabulary is deliberate).
- Splitting scenes until voicing-pure — scenes are chapters; pure-voicing
  boundaries live at the segment level, where they already exist.
- Validators (`auth_required`/`rate_limit`) — still story 07.
