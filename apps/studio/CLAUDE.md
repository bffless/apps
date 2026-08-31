# CLAUDE.md — Studio

Guidance for Claude Code when working in the Studio app. Studio turns one long, rambly screen
recording into a short video **in the user's own recorded voice** (cut-first — see
`docs/adr/0003-cut-first-editing.md`): an AI "master director" splits the recording into scenes and
proposes cuts; the producer tunes the cuts scene by scene (slice the clip, refine the cuts,
assemble). Nothing is re-voiced and the AI never rewrites what was said.

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

There is no app server. The `/api/*` endpoints are two sibling BFFless proxy rule sets, **authored**
under `.bffless/proxy-rules/studio/` (44 rules, the main set) and `.bffless/proxy-rules/studio-blog/`
(4 rules, the companion blog writer + blog image uploads) so a forker can build + import them into
their own project (attach BOTH to the app's alias) — see
`bffless/README.md` for import steps + prerequisites (storage, Replicate/Anthropic tokens,
`HF_TOKEN`). Locally, unhandled `/api/*` falls through the Vite proxy to `j5s.dev`. After changing
rules, edit the source under `.bffless/proxy-rules/<set>/` and commit — CI syncs it to the project on
deploy; check for drift with `npx bffless rules diff`.

Server-side video ops (`/api/video/{capabilities,slice,concat,extract-audio}`, CE's `ffmpeg_handler`) unlock on CE ≥ 0.4.25; the client probes once per session and falls back to `ffmpeg.wasm` on older CE. On CE ≥ 0.4.31 the probe also lists `executors` (`local` = ffmpeg in the backend, `remote` = the Cloud Run Worker) and the picker on the Auto Build board / prep card chooses **Browser | Server (auto) | Local server | Remote** (`src/lib/videoBackend.ts`; `?videoBackend=wasm|server|local|remote` override, persisted). Explicit choices send `executor` on the job body (the video rules pass it through); Auto Build's ffmpeg lane widens to `min(8, scenes)` when the *effective* executor is Remote (Remote chosen, or Server (auto) on an instance whose default executor is Remote) (`src/lib/autoBuild.ts`), and `FFMPEG_BUSY` job errors are retried (`src/lib/videoJobRetry.ts`; needs ce#662 for the code to reach the job row).

## The locked pipeline

Prep runs five stages **one at a time** (`STAGE_DEFS` in `src/lib/pipeline.ts`; top-level stepper is
Import → Prep → Build → Export):

1. **Upload source** → bucket (presigned, story 01)
2. **Extract + upload audio** (16 kHz mono WAV → bucket, story 01b)
3. **Transcribe** with word timestamps (WhisperX, story 02)
4. **Contact sheet** — interval-sampled frames composed into one timestamped image (browser-side)
5. **Master director** — `/api/scenes`: transcript + contact sheets → `google/gemini-3.1-pro` →
   `{ synopsis, scenes[] }`, each scene `{ title, start, end, transcript, refinePrompt, cuts[] }` (story 03)

Then **Build** (per scene, `CutEditor.tsx`): slice the scene's clip + dense sheets, optionally run
the per-scene refiner (`/api/refine-scene`, story 03c) for better `cuts`; hand-edit cuts on the
grid; assemble (kept spans, the clip's own audio). Export stitches the saved scene cuts via
ffmpeg.wasm (story 05+).

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

## Public surface (the retired workflow-studio seam)

`package.json` `exports` publishes `./lib/*` (a **wildcard over all of `src/lib/*.ts`** — every
module, not a curated subset), `./components/Studio/CutEditor`, `./components/Studio/clipPlayer`,
`./components/Studio/MarkdownBody`, `./components/Studio/MermaidDiagramView` and `./index.css`.
Through M3 this let workflow-studio, then in this monorepo (a re-authoring of this app's video pipelines as a
Workflow-harness implementation) depend on `studio: workspace:*` and import them directly
instead of forking the source. **The seam retired at the M4 move** (plan Decision 3):
workflow-studio now lives in `bffless/workflow-implementations` on copies of these modules
frozen at the move commit — Studio drift no longer flows into it, and no in-repo consumer
imports through this map today.

**Not everything under `lib/*` is store-free today.** Four modules touch the Redux slice:
`projectSync.ts` imports `freshWorkingState` from `../store/studioSlice` as a **value** (it
pulls `@reduxjs/toolkit` into any consumer at runtime, and `studioSlice.ts` imports
`projectSync` back — a cycle); `projects.ts`, `transcriptText.ts` and `studioRoute.ts` import
`ProjectWorkingState`/`TranscriptWord` from the slice as **types only** (erased at runtime, but
still a coupling). `CutEditor.tsx`, `clipPlayer.ts`, `MarkdownBody.tsx` (with the
`BlogFigure.tsx` it renders) and `MermaidDiagramView.tsx` are clean. `MarkdownBody` is
`MarkdownPreview` minus the ```mermaid renderer, which is injected (`diagram` prop) rather than
imported: `MermaidDiagram`'s lazy `import('mermaid')` would be inlined wholesale into a single-file
workflow island. The renderer itself — load once, render, fall back to the source with a note — is
`MermaidDiagramView`'s `createMermaidDiagram(load)`, which is mermaid-free: `MermaidDiagram` is it
over `import('mermaid')` (and stays OFF the export map for that reason), and the island is it over
a pinned CDN URL fetched at runtime (`islands/blog-editor/mermaid.ts`, apps#441). Keep
`MermaidDiagramView.tsx` free of any `mermaid` import, value or type.

The modules workflow-studio froze copies of are store-free (verified against the tree at the
move): `director`, `refiner`, `describe`, `blog`, `sources`, `contactSheet`, `filmstrip`,
`scenes`, `edl`, `slug`, `transcriptGrid`, `playback`, `deadSpace`, `autoTrim`, `audio`,
`search`, `frames`. Keeping them store-free (no `react-redux`/`@reduxjs/toolkit`/`../store`
import, value or type-only) is still good hygiene — it keeps them usable outside this app's
Redux tree — but since the M4 freeze nothing outside this repo breaks if one slips; the fence
that enforced it now lives with the frozen copies in `bffless/workflow-implementations`
(`workflow-studio/eslint.config.js`).

## Non-negotiable patterns

- **Mock-first, swap-don't-rewrite.** Every `/api/*` has an MSW mock in `src/mocks/handlers.ts`
  (gated by the `VITE_MOCK_STUDIO` env toggle, default off; CI smoke turns it on). Mock and real **must return the same shape** — coerce
  both through one pure `toX()` function. Unhandled `/api/*` falls through the Vite proxy to `j5s.dev`.
- **Never stream large files through a pipeline.** Edge nginx caps request bodies at **1 MB**.
  Uploads use the **presigned direct-to-bucket** flow. To feed a bucket object to Replicate, pass
  its `/api/uploads/...` serve path (or storage path) straight into the `replicate` step's `input` —
  the handler reads the object from storage itself and hands the bytes to Replicate, so it works on
  every storage backend. A server-minted `signed_url` also works, but only where the backend
  supports presigned GET. Either way the bytes never enter a request body.
- **Non-destructive layers.** The director's `cuts` are an immutable baseline; the refiner and
  hand-edits write to `scene.refined` (`source: 'ai' | 'manual'`). Reverting = `refined = null`.
  Downstream reads `refined ?? baseline` via `effectiveCuts`.
- **No base64 in Redux/localStorage.** Contact sheets and audio persist **url-only**.
- **One stage per PR**; `build`, `lint`, `test:run` must pass.
- **`data-testid`s are a contract.** The headless runner (`headless/`, story 14)
  drives the real site by these ids; renaming or removing one breaks unattended
  runs. The PR smoke workflow (`studio-headless-smoke.yml`) is the canary — if
  it fails after a UI change, restore the id rather than updating the runner.

## ffmpeg.wasm core-mt patch (pnpm-specific)

`scripts/patch-core-mt.mjs` runs on `postinstall`: it makes the multithreaded core load as a module
worker and raises its heap 1 → 3 GiB (glue `INITIAL_MEMORY` **and** the wasm memory-import max — both
halves required). pnpm needs two settings in `.npmrc` for this to be safe:
`enable-pre-post-scripts=true` (so the postinstall runs) and `package-import-method=copy` (so editing
`node_modules/@ffmpeg/core-mt` can't corrupt pnpm's shared store via a hardlink). **Do not** use
`pnpm patch` for this — its binary diff corrupts the 32 MB wasm.
