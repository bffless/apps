# 03 — Wire the AI master director (scenes + new script + cut info)

> Read `00-architecture-and-state.md` first.

**Status:** ✅ done · **Backend: BFFless `replicate` → `google/gemini-3.1-pro`
(multimodal). The brain of the feature.**

> **Shipped.** `/api/scenes` is live in the `studio` rule set (rule
> `138f27fb`): `prep` (build storage paths + the prompt + system instruction) →
> up to 10 conditional `signed_url` steps (one per contact sheet, mirroring how
> `/api/transcribe` signs the WAV so Replicate can fetch it) → `collect` →
> `replicate` `google/gemini-3.1-pro` (`images`, `prompt`, `system_instruction`,
> `thinking_level:high`) → `parse` (JSON-parse + clamp/coerce to the `Scene`
> shape) → `respond`. Front end: `src/lib/director.ts` (pure: `timedTranscript`,
> `toScenes`, `scenesToTimedWords` + tests), `studioApi.scenes`, the
> `DirectorPanel` (direction input + send action) on the prep page, a synopsis
> card + cut readout in Build, and the shortened script feeding the 02b diff's
> right pane. MSW mock gated by `MOCK_STUDIO`. Validators deferred to story 07
> like the upload/transcribe rules. ⚠️ `thinking_level:high` can approach the
> 120 s rule cap on long clips — dial to `medium` if it times out.

## Goal

Replace mocked `buildScenes` with the real **master director**: a single AI step
that takes the **transcript + a timestamped thumbnail contact sheet** and returns
the **scenes**, each as `{ title, new script text, original-video start/end
timestamps, cut info (footage spans to drop) }`. These become the scene queue,
the YouTube chapters, and the cut info the Build step applies to the footage.

The director gets **visual context** (the contact sheet), not just words — that's
how it can decide what footage to cut, not only how to rewrite the script.

## Inputs (prep produces these)

1. **Transcript** with word/segment timestamps (story 02).
2. **Contact sheet** — interval-sampled frames composed into one image with a
   timestamp burned on each frame (the Prep stage-4 work; scales the interval to
   clip length). Browser-side capture + compositing.

## Backend (`/api/scenes` pipeline)

1. **Director** — `ai_handler`/`replicate` **multimodal** LLM. Inputs = the
   timestamped transcript **and** the contact-sheet image. Prompt: "You're cutting
   a long talk into a tight short. Using the words and the frames, break it into
   logical scenes; for each, write the new script, give the original-video
   start/end it maps to, and the spans to **cut** from that footage."
2. `function_handler` — validate: clamp timestamps to `[0, duration]`, ensure
   ascending non-overlapping scene spans, clamp/normalize cut spans within each
   scene, coerce to the `Scene` shape from `src/lib/scenes.ts`.
3. `response_handler` — `{ synopsis, scenes: [{ title, start, end, transcript,
   draftText, cuts: [{ start, end }] }] }`. (`synopsis` is the one-line logline
   of the whole talk — a late addition; shown as a card in Build.)
4. Validators: `auth_required` + `rate_limit`.

## Front-end

- Mock `/api/scenes` in MSW (canned scenes with new script text, timestamps, and
  cut spans).
- Add the **contact-sheet** step (interval capture + compositing) to prep before
  the director call — extend `src/lib/frames.ts`.
- In `useScenePipeline.ts`: the director stage calls the pipeline; set `scenes`
  from the response. The scene workspace consumes the `Scene` shape — extend it
  with `cuts` (build applies them — see `00` "Build").
- Feeds the transcript editor's right pane (02b) with the new script.

## Acceptance criteria

- [x] Real scenes come back with new script text, valid in-bounds ascending
      timestamps, and cut spans; they populate the queue and the chapter list.
- [x] The director receives the contact sheet as image input (multimodal), not
      transcript alone (each sheet is signed and passed in `images`).
- [x] Mock and real share the `Scene` shape (`toScenes` coerces both; swap, don't
      rewrite the UI).
- [x] Timestamps + cut spans validated/clamped server-side (`parse` step) **and**
      client-side (`toScenes`). `auth_required` + `rate_limit` deferred to story
      07 (mirrors the upload + transcribe rules) so local dev works.
- [x] build/lint/tests pass (107 tests).

## Out of scope

Applying the cuts / playing the cut video and the per-scene refiner (Build —
heavy, later), voice clone / TTS (04), assemble/render (05). The final **YouTube
thumbnail** (06) is unrelated — that's an AI **output**, not this director input.
