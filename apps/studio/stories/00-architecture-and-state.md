# 00 — Architecture & current state (read first)

> **📍 Progress:** Scene-producer prototype ✅ shipped (browser stages real,
> pipeline/AI stages mocked — see `../../done/00-scene-producer-prototype.md`).
> Next: wire the real pipelines in order. See `README.md` for the status table.

Shared context for every Studio story. Read this, then your story file. Don't
re-derive any of this from chat history — it's all here.

## What this is

`/studio` turns **one long, rambly screen recording (e.g. 45 min) into a short
video re-voiced in the user's own cloned voice**. It is **not** a manual editor
(a hand-editor was built and scrapped) and not a one-shot auto-shortener. The AI
does the rewriting up front; the user then **produces the result scene by
scene**.

The browser UI = a top-level **stepper** (Import → Prep → Build → Export, from
`studioPhase` in `src/lib/pipeline.ts`) for orientation, then a **prep "notes"
board** (steps run **one at a time** — the current step shows its action button)
followed by a **scene workspace** (a chapter/scene queue + a per-scene editor you
work one at a time).

## The locked flow

> This section is the **product target**. Some of it (the contact sheet, the
> master director's cut info, the scene refiner) isn't built yet — it's the
> direction, not the current code. Where today's code differs, it's called out.

**Prep — assemble the ingredients, then let a "master director" cut the talk.**
`src/lib/pipeline.ts` `STAGE_DEFS` is the board; `useScenePipeline.next(ctx)`
runs the current step.

| # | Stage | Where | Today |
|---|-------|-------|-------|
| 1 | Save the clip to a bucket | pipeline | **real** (presigned, story 01) |
| 2 | **Extract & upload audio** (16 kHz mono WAV → bucket) | browser + pipeline | **real** (presigned `/api/uploads/audio`, story 01b) |
| 3 | Transcribe with timestamps | pipeline | **real** (WhisperX, story 02) |
| 4 | **Sample interval thumbnails → compose a timestamped contact sheet** | browser | mock (per-scene frames today; see below) |
| 5 | **Master director** — send {transcript + contact sheet} to the AI; get **scenes + new script + cut info** back | pipeline | mock (`buildScenes`) — story 03 |
| 6 | Clone your voice | pipeline | mock — story 04 |

Stage 2 extracts the WAV in-browser **and** uploads it on its own (presigned,
`/api/uploads/audio`), so stage 3 hands Replicate an audio URL — we transcribe
the WAV, not the source video.

Stage 4 samples frames on an **interval that scales with clip length** and
composes them into **one image with a timestamp burned on each frame**, so the
director gets **visual context**, not just words.

Stage 5 — the **master director** — takes {transcript + contact sheet} and
returns **scenes**, each = `{ title, new script text, original-video start/end,
cut info (footage spans to drop) }`. These double as YouTube chapters.

**Build — voice each scene's script and line the cut video up with it.** Per
scene, one at a time: **generate the cloned-voice narration from the new script**
(it isn't pre-baked — you create it here), apply the director's **cut info** to
the footage and **play the cut video** (the trimmed scene) against the narration
to check it lines up; refine the script (edit/remove words) and **re-voice** until
it's right; **mark built**. When all scenes are built, **assemble** them with
ffmpeg.wasm into the final cut.

- The voice **isn't there to begin with** — no pre-baked narration when you enter
  a scene. You voice the script in Build, and **re-voice whenever you edit the
  text**.
- **End goal (heavy, later):** a **per-scene refiner** — a scene-level version of
  the master director that samples **finer-interval thumbnails** for the one scene
  and tightens its cut. May reuse the director pipeline or be its own.

## Two kinds of thumbnails — don't conflate them

1. **Director thumbnails — INPUT to the AI.** Interval-sampled contact sheets
   (whole-clip in Prep; finer and per-scene in the Build refiner). We **give**
   these to the AI so it can see the footage. Browser-side capture + compositing.
2. **YouTube thumbnail — OUTPUT from the AI (story 06, nano-banana).** When
   everything's done, we generate the final YouTube thumbnail image and get it
   **back** from the AI. A separate, self-contained feature.

**Later — reuse the director thumbnails as a build-step scrubbing sprite.** The
prep contact-sheet frames are already captured, timestamped, and uploaded to the
bucket (`thumbnails/` subDir). Since the transcript words also carry timestamps
(story 02), the Build step can show the matching frame as the user moves through
the words — a cheap visual scrub — by reusing those same frames as a sprite
sheet instead of re-capturing. (Today's per-scene thumb is a single midpoint
frame; this is the finer-grained version.)

## Open questions (to reconcile before building)

- **Cut info vs. footage-fit.** The director now returns **cut info** per scene,
  and Build voices the script there. Story 05 still frames assemble as "fit footage
  to narration length" (trim/speed) — decide how much the director's cuts already
  settle that vs. what assemble still has to stretch. See story 05's open design
  question.

## Key technical facts

- **Audio extraction is real, browser-side** (`src/lib/audio.ts`): WebAudio
  decode → OfflineAudioContext (mono + 16 kHz) → WAV PCM16 Blob. Upload the WAV
  (not the video) for STT.
- **Frame capture is real, browser-side** (`src/lib/frames.ts` `captureFramesAt`):
  seek a detached `<video>` → canvas. Today it grabs one frame per scene midpoint;
  the **director** needs the opposite — **interval-sampled frames composed into a
  timestamped contact sheet** (new work) handed to the AI as visual context.
- **Scene model** lives in `src/lib/scenes.ts` (`Scene`, `buildScenes` = mock
  director, `narrationSeconds`, `alignment`). The real director (story 03) replaces
  `buildScenes` and returns the same `Scene` shape — to be **extended with the cut
  info** (footage spans to drop) that the build step applies.
- **State + persistence (story 00c)**: durable business state lives in the Redux
  `studio` slice (`src/store/`), persisted to **localStorage** via redux-persist,
  so a hard reload resumes mid-pipeline. `/api/*` calls go through **RTK Query**
  (`studioApi`). Only transient UI (the in-memory `File`/object URL, `currentTime`,
  `running`/`voicingId`) stays as React state. Mock everything via `MOCK_STUDIO`
  in `src/mocks/handlers.ts`.
- **Orchestration**: `src/components/Studio/useScenePipeline.ts` runs the prep
  stages and owns the scene queue + per-scene edit/voice/build state, now backed
  by the Redux slice + RTK Query (same return shape). **Swap a mocked stage for a
  real `/api/*` call here without touching the UI.**
- **Final render = ffmpeg.wasm in the browser** (story 05). Multithreaded
  ffmpeg.wasm needs COOP/COEP cross-origin-isolation headers (set via a BFFless
  cache/response-header rule on `/studio`); single-threaded works without them —
  start there.

## BFFless building blocks (for wiring)

Pipelines = handler chains, no server code. Relevant handlers: `file_upload`
(→ storage), `file_serve` (Range-aware), `signed_url`, `replicate` (whisper for
STT; an LLM/Gemini for shorten+segment; voice-clone + TTS — auto-uploads large
inputs to Replicate Files), `ai_handler`, `function_handler`, `http_request`,
`stripe_checkout`/`stripe_webhook`. Validators: `auth_required`, `rate_limit`.
Expressions: `input.*`, `query.*`, `steps.<name>.*`, `user.*`.

Front-end calls `/api/*` with `fetch(..., {credentials:'include'})`; mirror the
upload-then-POST flow in `src/components/ContactDialog.tsx`. **Mock every new
`/api/*` in `src/mocks/handlers.ts` (MSW) first**, build the UI, then wire it.

## Conventions (enforced — don't fight them)

- **Tailwind v4, CSS-first** — tokens in `src/index.css` `@theme`; reuse
  `.pill-cta`, `.pill-ghost`, `.meta-label`, `.container-page`, `.rule`,
  `<Section>`/`<PageHero>`/`<Dot>`. Paper/ink/terracotta editorial look.
- **Fix the code, not the config** — ESLint is strict; `react-hooks/
  set-state-in-effect` and `react-hooks/refs` are **errors**. Derive with
  `useMemo`, sync refs in effects, remount via `key`. No disable comments.
- **Pure logic in `src/lib/*`, unit-tested** next to source (`*.test.ts`).
- **Don't browser-verify / pixel-perfect during prototyping** — rely on build/
  lint/tests and describe behavior (user preference).
- **GitHub via `gh`, never `curl`.** Each stage is its own PR; `npm run build`,
  `npm run lint`, `npm run test:run` must pass.

## Commands

`npm run dev` · `npm run build` · `npm run lint` · `npm run test:run`
· `npx vitest run src/lib/scenes.test.ts` · `npm run test:e2e`.
