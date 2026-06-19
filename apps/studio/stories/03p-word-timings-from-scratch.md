# 03p — refiner refines from scratch off per-word timings

> Read `00-architecture-and-state.md` first. This reshapes the `/api/refine-scene`
> request + the deployed prep prompt (rule `afacb572`), and finishes the
> "trust-the-tag" arc started in 03o.

**Status:** ✅ shipped (2026-06-12). Builds on 03o (trust the model's `source`
tag; text is a label, not a gate).

## Why

03o made `toRefinement` trust the model's `original`/`revoice` tag and its own
`start`/`end` — dropping the verbatim gate AND the 03n snap. That removed the
false "asked for original, got revoice" demotions, but left the model emitting
**coarse** timestamps: it only ever saw the 8s-bucketed `timedTranscript`
(`director.ts`), so a tag's span was eyeballed inside an 8-second line and could
clip a word or swallow a false start. The fix is to give the model the precise
numbers it was missing.

## What changed

**Request (`RefineSceneRequest`):** dropped `transcript` (8s buckets), `draftText`
and the director's first-pass `cuts`. Added **`wordTimings`** — the scene's words
as `start end word` lines (`sceneWordTimings` in `refiner.ts`), exact seconds on
the shared timeline. The refiner now refines **from scratch** off precise word
times + the creator direction; the director's first pass is no longer fed in
(it stays the immutable baseline on the `Scene` — revert still works).

**Deployed prep prompt (rule `afacb572`):**
- "Scene Refiner doing a SECOND pass on a first-pass rough" → **"Scene Editor …
  there is NO first-pass script — build the tightened cut from scratch."**
- `SCENE TIMESTAMPED TRANSCRIPT` (+ the two FIRST-PASS sections) → a single
  `SCENE WORD TIMINGS` block, with "set start/end by COPYING the exact times of
  the first and last kept word."
- `createJob` prompt/system (03m transparency) preserved — a stale pre-03m backup
  had dropped them; rebuilt from the live rule (see Gotcha below).

**Mock (`handlers.ts`):** `mockRefiner` now parses `wordTimings` and builds a
from-scratch fixture (original first run + revoice second run + a cut), no longer
derived from `draftText`.

## Files

`src/lib/refiner.ts` (`sceneWordTimings`, trimmed `RefineSceneRequest`) ·
`refiner.test.ts` (+3) · `useScenePipeline.ts` (request swap; `completeRefineJob`
deps no longer need `words`) · `src/mocks/handlers.ts` · rule `afacb572` prep.

## Gotcha — the backup was stale

The `.bffless-backups/*03m*` snapshot was a **pre-03m** state: its `createJob` was
missing the `prompt`/`system` fields 03m added. Building the update from it would
have silently regressed the PromptDisclosure. Always `get_proxy_rule` the LIVE
rule and diff before pushing. The deploy also took two tries — the first
`update_proxy_rule` socket dropped mid-write (verified not applied via re-fetch;
`updatedAt` unchanged), the retry landed (`updatedAt` 11:54:04Z).

## Boundary tuning (2026-06-12, follow-up deploy)

Real runs clipped word onsets/tails — WhisperX word stamps are tight, so copying
them exactly cuts the first/last phoneme. Per James: **bias toward inclusion** (he
can trim by hand, but can't recover removed audio). Added a `BIAS TOWARD INCLUDING
MORE, NOT LESS` rule to the prep system prompt: pad each kept-segment edge ~0.2s
outward into adjacent silence, cut only clearly-unwanted material, keep cut edges
clear of kept words, prefer longer segments + fewer/smaller cuts. Rule redeployed
(`updatedAt` 12:08:34Z; backup `2026-06-12-03p2-refine-scene.json`).

This is a soft (prompt) nudge — the model still emits the numbers. If clipping
persists, the reliable fix is a deterministic outward pad in the `parse` step /
client coercion rather than relying on the model's arithmetic.

## Unverified

Live Gemini behavior with the new from-scratch + word-timings prompt is not yet
confirmed against a real run (needs the Replicate token). The prep handler was
dry-run locally (node) to confirm the rendered prompt; the parse/coerce path is
unchanged.

## Out of scope / follow-ups

- Surfacing the rare genuine downgrade in the UI (still none — nothing downgrades).
- If the model's copied timings still drift, consider having it return word
  INDICES into the `wordTimings` list instead of floats.
