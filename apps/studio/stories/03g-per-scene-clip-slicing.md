# 03g — Per-scene clip slicing (cut each scene to its own video)

> Read `00-architecture-and-state.md` first, then this. Skill: `wire-studio-stage`
> for the end-to-end pattern, `bffless-pipeline` for the upload rule.

## The problem (why this exists)

Assemble today is **one whole-film pass**, not per-scene. `AssembleBar`
(`src/components/Studio/AssembleBar.tsx`) is rendered once in the Export step
(`Studio.tsx:508`), flattens **every** scene's segments + cuts, and runs a single
`planAssembly` over the entire `[0, duration]` timeline against the **full source
video** loaded into ffmpeg.wasm's MEMFS.

That falls apart at length. On a 3:48 clip the Export bar reads
`3:48 → 1:16 (2:32 cut)` — proof it is walking the whole source — and it drags the
full raw file through one giant `filter_complex` (every kept-footage `trim`, one
big `concat`, every audio clip + silence) in a single `libx264` re-encode. The
result: a ~10-minute run that produced **garbage with no audio, broken ~8s in**.
The full file sits in a 32-bit wasm heap (~2 GB ceiling) alongside decode
buffers, the graph balloons, and the single-threaded encode chokes. At ~53s the
same code works fine.

**The fix is divide-and-conquer:** give every scene its own small clip, so all
downstream work touches a ~1–2 min file (the regime that already works), never
the whole film. This story builds the slicing half; the per-scene assemble +
master-concat is the follow-on phase.

## Model

- Slicing is **lazy and per-scene** — a build step you run when you start working
  a scene, not an eager batch after `/api/scenes`. It joins the existing per-scene
  steps (contact sheets, refine) as **step 0**, in front of them.
- The cut **re-encodes** the raw's `[start, end]` span (scene 1 = `0:00–1:44`,
  scene 2 = `1:44–3:48`) in ffmpeg.wasm. We tried `-c copy` for speed and it
  produced broken clips — stream-copy snaps to keyframes, writing an MP4 edit list
  that makes the player start partway in and refuse to seek to 0, and the
  packet-boundary cut leaves the audio ending before the video. Re-encoding
  rebuilds clean timestamps from `t=0` and keeps A/V the same length, so clip-local
  rebasing downstream is a plain `−scene.start`. It runs per scene on a short span
  (never the whole timeline). **It is slow in single-threaded wasm** — the speed
  fix is multithreaded ffmpeg.wasm (`core-mt` + COOP/COEP), tracked as a follow-up,
  not a stream-copy hack.
- The clip is **presign-uploaded to the bucket** and its serve URL persisted on
  the scene (`Scene.clipUrl`), like every other artifact — survives reload; a
  reload with `clipUrl` set means the cut's already done; re-cut overwrites it.
- Once cut, the **Build preview player plays the scene clip**, not the full film
  — fixing the "video at the top is the full 3:48 video" problem directly.

## Scope — two phases, ONE branch (`feat/studio-upload-bucket`, no PRs)

**Phase 1 (this work — ✅ done):** the "Cut this scene" step → clip in bucket →
`Scene.clipUrl`, plus swapping the Build preview to the clip. Self-contained and
demonstrable: cut scene 1, the left-hand player becomes the 1:44 clip.
Shipped: `Scene.clipUrl`; pure `buildSliceCommand` + tests (`src/lib/export/slice.ts`);
`slice()` executor (`src/lib/export/ffmpeg.ts`); `'scene-clip'` upload kind;
`slicingId` + `sliceScene` in `useScenePipeline`; step 0 in `SceneRefinePanel`;
Build preview swap in `Studio.tsx` (clip player uses a no-op `onLoaded` so it
never clobbers the full-source `duration` the grid is keyed to); the 3 live rules
above. Persisted via the existing generic `patchScene` reducer (no new reducer).

**Phase 2 (✅ done, same branch):** assemble is now **per-scene, tab by tab**, off
each scene's `clipUrl`, with a separate **master concat** for the whole video —
fixing the whole-film OOM (only one short clip is in wasm memory at a time).
- `planScene()` (pure, `assemble.ts`) rebases a scene's effective cuts/segments to
  its clip-local timeline (`− scene.start`) and reuses `planAssembly`.
- `SceneAssembleBar` (keyed by selected scene) renders **just the selected tab's
  scene** off its clip → preview → **save** (`scene.assembledUrl`, via `saveSceneCut`,
  reusing the `export` upload). You do each scene as you build it.
- `FinalCutBar` is the **master assemble**: `buildConcatCommand` + `concat()`
  stream-copy join every scene's saved `assembledUrl` → `finalCutUrl`. Enabled once
  all scenes are assembled. No re-encode, near-instant, no OOM.
- The old whole-film `AssembleBar` (one pass over the raw across the full timeline —
  the OOM source) is **removed**.

## Phase 1 — the pieces

### Data model (`src/lib/scenes.ts`)
Add to `Scene`:
```ts
/** Serve path of this scene's own sliced clip ([start,end] of the source),
 *  once cut (story 03g). Absent until the "Cut this scene" step runs; the Build
 *  preview and the per-scene assemble (phase 2) read it instead of the full
 *  source. Re-cutting overwrites it. */
clipUrl?: string
```
(`clipSeconds` is derivable as `end − start`; don't store it.)

### Pure logic + tests (`src/lib/export/`)
- A small pure helper that builds the ffmpeg **trim argv** for a scene span —
  `buildSliceCommand({ start, end, source?, output? })` — frame-accurate
  (`-ss`/`-to` with `-accurate_seek`, re-encode `libx264 ultrafast` + aac,
  `+faststart`). Unit-tested next to source (`*.test.ts`) like `assemble.ts`.
- The clip-local rebasing math (`original = clipTime + scene.start`, and the
  inverse for cuts/segments) lives as a tiny pure helper too, with tests — phase
  2 consumes it but the preview swap needs the forward map now.

### ffmpeg executor (`src/lib/export/ffmpeg.ts`)
Reuse the existing lazy single-threaded core. Add a thin `slice(...)` that writes
the source, execs the trim argv, reads back the clip Blob, cleans up — same shape
as `assemble()`.

### Orchestration (`src/components/Studio/useScenePipeline.ts`)
- New busy flag `slicingId: string | null` (mirror `sheetingId`/`refiningId`).
- `sliceScene(sceneId)`: get the source bytes (in-memory `file` ?? fetch
  `sourceUrl`), run `slice(...)`, presign-upload the clip
  (`uploadReq({ file, kind: 'scene-clip' })`), then persist via a new
  `setSceneClip({ id, url })` reducer. Mirror the `adoptOriginal` (03d) slice +
  upload precedent.

### State (`src/store/studioSlice.ts`)
`setSceneClip` reducer sets `scene.clipUrl`. (Reset clears it with the scene.)

### UI (`src/components/Studio/SceneRefinePanel.tsx`)
Add **step 0 · Cut this scene** above the contact-sheet step: a button driven by
`slicingId === scene.id`, showing "Cut scene" / "Cutting…" / "Re-cut" + a
"clip ready" affordance once `scene.clipUrl` is set. Wire from `Studio.tsx`:
`slicing={pipe.slicingId === selected.id}` / `onSlice={() => pipe.sliceScene(selected.id)}`.

### Build preview swap (`src/pages/Studio.tsx:460`)
When the selected scene has a `clipUrl`, the Build player's `src` becomes the
clip. Two **gotchas** (call them out in code):
1. **Don't clobber the global `duration`.** `onLoaded` sets the Redux `duration`
   the entire diff grid/filmstrip is keyed to (the full-source length). The Build
   clip player must **not** call it — pass a no-op / omit `onLoaded` there, or
   gate it so it only fires for the full-source preview.
2. **Time-base offset.** The clip plays clip-local (`t=0` = `scene.start`); the
   grid/cuts/filmstrip are in original-video seconds. For scene 1 (`start=0`)
   they coincide; scene 2+ needs `original = clipTime + scene.start`. Keep the
   Build player a pure clip *viewer* decoupled from the grid's original-time
   `currentTime`, OR offset its `onTime` by `scene.start`. (Today the Build
   `PreviewPlayer` passes `cuts={[]}` and no `onTime`, so the minimal path is:
   just swap `src`, leave it a viewer.) Fall back to the full source when
   `clipUrl` is absent.

### BFFless rule (`bffless-pipeline` skill) — ✅ built
New presigned **scene-clip** upload in the live `studio` rule set
(`cf413ff6-4989-44a6-afc9-75c3545b5e8e`), mirroring the `source` rules exactly
(video/\*, 2 GB, `dateBucket`, validators **off** until story 07). Reuses the
studio upload schema `8afd205a-204d-4dcd-9e2f-7cd613ec961f` (scene clips are
videos, same record shape as `source`). Rules:
- `411715e9` — `POST /api/uploads/scene-clip/prepare` (presigned_upload)
- `a2d0fd0e` — `POST /api/uploads/scene-clip/register` (register_upload)
- `66e25e30` — `GET  /api/uploads/scene-clip/*` (file_serve_handler)

### Mock (`src/mocks/handlers.ts`)
No new handler needed: the `MOCK_STUDIO` upload mocks already match
`/api/uploads/:kind/(prepare|register)` and `GET /api/uploads/:kind/*`
generically, so `kind: 'scene-clip'` rides them as-is.

## Speed: multithreaded ffmpeg.wasm

The re-encode is the right tool for correctness but slow in **single-threaded**
wasm. The fix is the **multithreaded** core (`@ffmpeg/core-mt`), which parallelizes
the encode across CPU cores and speeds up the slice **and** the eventual assemble.

- **Loader** (`src/lib/export/ffmpeg.ts`): prefers the MT core when the page is
  cross-origin isolated (`globalThis.crossOriginIsolated`), else the single-threaded
  core. Best-effort + **never fatal** — any MT load failure falls back to ST.
  `coreVariant` exposes which loaded.
- **The core-mt fix** (`scripts/patch-core-mt.mjs`, run on `postinstall`): core-mt's
  ESM pthread worker is written for a **module** worker (loads the core via dynamic
  `import()`), but emscripten's `allocateUnusedWorker` spawns it with `new Worker(url)`
  — no `{type:"module"}` — so it loads as a **classic** worker and dies on `import`
  ("Cannot use import statement outside a module"; ffmpeg.wasm issue #603). The patch
  adds `{type:"module"}` to both `new Worker(...)` calls in the ESM core. Idempotent;
  fails loudly if the target strings move (a core-mt version bump). This is **the**
  long-standing "core-mt incompatible with @ffmpeg/ffmpeg@0.12.x" blocker.
- **Bundling**: `@ffmpeg/core-mt` added; `vite.config.ts` `build.assetsInlineLimit`
  forces `ffmpeg-core*` assets to emit as real files (Vite otherwise base64-inlines
  the ~2 KB pthread worker as a `data:` URL emscripten can't spawn pthreads from).
  `optimizeDeps` excludes core-mt too.
- **Dev vs. build — important.** The patch only takes effect in the **built** asset.
  Vite's **dev server** serves the core through its own transform, where the patched
  worker still loads classic and fails. So COOP/COEP isolation is set **only on the
  Vite `preview` config, NOT `server`**: `npm run dev` stays **single-threaded**
  (not isolated → ST core, works), and MT is verified via `npm run preview` and in
  production. Don't add `server.headers` — it re-breaks dev cutting.
- **Isolation headers** = COOP `same-origin` + COEP `credentialless` (gentle mode —
  cross-origin subresources load without credentials instead of being blocked, so
  the studio media keeps working).
  - **Production (preview.j5s.dev)**: the `/studio` document needs these headers via
    a **Response Header Rule** (BFFless Settings → Response Headers; NOT exposed by
    the MCP, so set in the UI; ✅ now set — `**` pattern, `COOP: same-origin` +
    `COEP: credentialless`). Hashed asset responses cached by the CDN *before* the
    rule existed serve stale (no COEP) until purged — purge once after adding it.
- **⚠️ Browser support — Firefox only, for now.** Full MT (slice **and** the
  audio-mixing assemble, with normal `-c:a aac`) runs correctly in **Firefox**.
  **Chromium and Safari hang** the moment core-mt has to *encode audio* — a known,
  unfixed cluster of core-mt pthread-runtime deadlocks: ffmpeg.wasm
  [#772](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/772) (audio-encode hang,
  works in Firefox) and [#883](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/883)
  (core-mt encode deadlock). We deliberately **keep full audio re-encode** (no
  `-c:a copy` workaround) and treat MT as **use-Firefox-until-upstream-fixes-it**,
  rather than degrade the audio path. Revisit when #772/#883 close or core-mt moves
  to FFmpeg 6.x (#930/#743). The loader still falls back to ST when not isolated, so
  non-isolated contexts are unaffected.

## Non-goals
- Per-scene **assemble** off `clipUrl` and the **master-concat** at Export
  (phase 2).
- Stream-copy / multithread / encode-quality tuning (still parked, story 05).
- Touching the validators-off posture (story 07).

## Done when
`npm run build`, `npm run lint`, `npm run test:run` pass; cutting a scene uploads
a clip and persists `clipUrl` (survives reload); the Build preview plays the scene
clip (not the full film) once cut, with the diff grid still keyed to the full
source duration.
