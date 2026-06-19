# 03r — seam-aware refiner context (previous scene lead-in)

> Read `00-architecture-and-state.md` first. This adds three fields to the
> `/api/refine-scene` request and the deployed prep prompt (rule `afacb572`).
> Design: `docs/superpowers/specs/2026-06-13-seam-aware-refiner-context-design.md`.

**Status:** 🔨 FE shipped + rule `afacb572` prep updated (2026-06-13). Live Gemini
effect unverified (needs the Replicate token).

## Why

Each scene is refined in its own isolated `/api/refine-scene` call
(`useScenePipeline.refineScene`) — the model never sees its neighbors. When the
scenes are stitched together the seams often don't flow: scene N's narration can
open in a way that clashes with how scene N-1 ended, because the two were written
independently. Reported by James from real stitched output.

## What changed

**Request (`RefineSceneRequest`, `refiner.ts`):** three new fields —
- `sceneNumber` (1-based) + `sceneCount` — so the model can place the scene in the
  arc ("scene 3 of 7").
- `previousContext` — the **tail** of the previous scene's *effective* narration
  (`sceneTail`, ~last 30 words of `effectiveSegments(prev)`; refined segments if
  present, else the original-transcript fallback). `''` for the first scene.

Kept as a **dedicated field**, not folded into `direction` — it's machine context,
distinct from the creator's intent (`direction`/`directorDirection`), so the
prompt-transparency disclosure (03m) doesn't mislabel it as the creator's prompt.

**`sceneTail(scene, maxWords=30)`** lives in `refiner.ts` (next to
`effectiveSegments`, which it reads — `scenes.ts` can't import it without a cycle).
Pure + unit-tested (`refiner.test.ts`, +5).

**Wiring (`useScenePipeline.refineScene`):** computes the previous scene from the
in-scope `scenes` array (`findIndex` on id) and passes the three fields. Automatic
— no UI toggle, no button change.

**Mock (`handlers.ts`):** accepts the three fields and surfaces them in the
`enqueueJob` prompt-label string (so the PromptDisclosure reflects the seam
context). The deterministic `mockRefiner` fixture output is unchanged.

**Deployed prep prompt (rule `afacb572`, `prep` step):**
- A `CONTINUITY:` paragraph added to the system instruction: this scene is one of
  several stitched in order; when given a lead-in, open so it follows naturally —
  pick up the thread, match cadence, don't repeat it; the previous-scene text is
  context only, never include/repeat/re-voice it.
- Two conditional prompt blocks: `POSITION IN THE TALK: scene N of M` and
  `THE PREVIOUS SCENE'S NARRATION ENDED WITH: "…"`.
- **Backward-compatible:** when the fields are absent (the currently-deployed FE),
  both blocks are skipped and the `CONTINUITY:` rule is harmlessly inert — output
  is byte-identical to pre-03r. Dry-run in node confirmed both the with-context and
  old-FE paths render correctly. Patched via `update_pipeline_step` (prep only).

## Files

`src/lib/refiner.ts` (`sceneTail` + 3 request fields) · `refiner.test.ts` (+5) ·
`src/components/Studio/useScenePipeline.ts` (compute prev + 3 fields) ·
`src/mocks/handlers.ts` (accept + label) · rule `afacb572` `prep`.

## Trade-off (noted, not solved)

`previousContext` is a snapshot at refine time. Re-refining scene N-1 *after* scene
N leaves scene N's lead-in stale until N is re-refined. Acceptable — it's a hint,
not a contract, and refining is cheap. A future story could flag downstream scenes
as "context changed."

## Out of scope

One-sided (previous only, not next-scene head), no UI toggle, no auto-re-refine
cascade.

## Unverified

Live Gemini behavior with the seam context is not yet confirmed against a real run
(needs the Replicate token). The `prep` handler was dry-run locally (node) to
confirm the rendered prompt; the `parse`/coerce path is unchanged.
