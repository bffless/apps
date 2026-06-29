# CLAUDE.md — Studio

Guidance for Claude Code when working in the Studio app. Studio turns one long, rambly screen
recording into a short video **re-voiced in the user's own cloned voice**: an AI "master director"
shortens the transcript and splits it into scenes; the producer then builds each scene one at a time
(refine the cut, voice the script, assemble).

This app was extracted from the `example-upload` demo site into the `bffless-apps` monorepo. It is a
self-contained pnpm workspace package — it no longer shares code with the demo site (it carries its
own copies of the few shared bits it used). The backend `/api/*` pipelines still live on the
`j5s.dev` BFFless project.

## Commands (run from repo root or with `--filter studio`)

- `pnpm --filter studio dev` — Vite dev server with HMR
- `pnpm --filter studio build` — type-check (`tsc -b`) then `vite build` into `apps/studio/dist/`
- `pnpm --filter studio lint` — ESLint (flat config)
- `pnpm --filter studio test:run` — single Vitest run (CI mode); `test` for watch
- Single file: `pnpm --filter studio exec vitest run src/lib/scenes.test.ts`

Root aliases exist too: `pnpm studio:dev|build|lint|test`.

## Source of truth

`stories/` holds the design. Read `00-architecture-and-state.md` first, then the specific story.
Don't re-derive the design from chat history or git log.

## Backend (`/api/*`)

There is no app server. The `/api/*` endpoints are a BFFless proxy rule set, exported to
`bffless/studio.proxy-rules.json` (43 rules) so a forker can import it into their own project — see
`bffless/README.md` for import steps + prerequisites (storage, Replicate/Anthropic tokens,
`HF_TOKEN`). Locally, unhandled `/api/*` falls through the Vite proxy to `j5s.dev`. After changing
rules in the dashboard, re-export and commit the updated JSON.

## The locked pipeline

Prep runs six stages **one at a time** (`STAGE_DEFS` in `src/lib/pipeline.ts`; top-level stepper is
Import → Prep → Build → Export):

1. **Upload source** → bucket (presigned, story 01)
2. **Extract + upload audio** (16 kHz mono WAV → bucket, story 01b)
3. **Transcribe** with word timestamps (WhisperX, story 02)
4. **Contact sheet** — interval-sampled frames composed into one timestamped image (browser-side)
5. **Master director** — `/api/scenes`: transcript + contact sheets → `google/gemini-3.1-pro` →
   `{ synopsis, scenes[] }`, each scene `{ title, start, end, transcript, draftText, cuts[] }` (story 03)
6. **Voice** — clone the user's voice / reuse a saved `voice_id` / pick a MiniMax preset (story 04)

Then **Build** (per scene, `TranscriptDiff.tsx`): optionally run the per-scene refiner
(`/api/refine-scene`, story 03c) for anchored `segments` + better `cuts`; hand-edit cuts; voice each
segment; mark built. Export assembles via ffmpeg.wasm (story 05+).

## Layout

- **State:** durable business state in the Redux `studio` slice (`src/store/studioSlice.ts`),
  persisted to localStorage via redux-persist. `/api/*` goes through RTK Query
  (`src/store/studioApi.ts`). Only transient UI stays in React `useState`.
- **Pure logic** in `src/lib/*`, unit-tested next to source (`*.test.ts`): `scenes.ts`,
  `director.ts`/`refiner.ts` (request shaping + response coercion), `frames.ts`/`contactSheet.ts`,
  `filmstrip.ts`, `audio.ts`, `transcriptGrid.ts`, `pipeline.ts`, `export/*` (ffmpeg assemble).
- **Orchestration:** `src/components/Studio/useScenePipeline.ts` runs the prep stages + scene queue.
- **App shell:** `src/App.tsx` serves at the **root** (`/`, `/project/:id`, `/project/:id/:phase`) —
  the old `/studio` route prefix was dropped on extraction. `src/main.tsx` wires the store +
  MSW bootstrap.

## Non-negotiable patterns

- **Mock-first, swap-don't-rewrite.** Every `/api/*` has an MSW mock in `src/mocks/handlers.ts`
  (gated by `MOCK_STUDIO`, currently `false`). Mock and real **must return the same shape** — coerce
  both through one pure `toX()` function. Unhandled `/api/*` falls through the Vite proxy to `j5s.dev`.
- **Never stream large files through a pipeline.** Edge nginx caps request bodies at **1 MB**.
  Uploads use the **presigned direct-to-bucket** flow; feed a bucket object to Replicate via a
  server-minted `signed_url`.
- **Non-destructive layers.** The director's `draftText`/`cuts` are an immutable baseline; the
  refiner and hand-edits write to `scene.refined` (`source: 'ai' | 'manual'`). Reverting =
  `refined = null`. Downstream reads `refined ?? baseline` via `effectiveSegments`/`effectiveCuts`.
- **No base64 in Redux/localStorage.** Contact sheets and audio persist **url-only**.
- **One stage per PR**; `build`, `lint`, `test:run` must pass.

## ffmpeg.wasm core-mt patch (pnpm-specific)

`scripts/patch-core-mt.mjs` runs on `postinstall`: it makes the multithreaded core load as a module
worker and raises its heap 1 → 3 GiB (glue `INITIAL_MEMORY` **and** the wasm memory-import max — both
halves required). pnpm needs two settings in `.npmrc` for this to be safe:
`enable-pre-post-scripts=true` (so the postinstall runs) and `package-import-method=copy` (so editing
`node_modules/@ffmpeg/core-mt` can't corrupt pnpm's shared store via a hardlink). **Do not** use
`pnpm patch` for this — its binary diff corrupts the 32 MB wasm.
