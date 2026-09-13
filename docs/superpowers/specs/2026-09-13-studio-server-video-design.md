# Studio: all video work on the server

Date: 2026-09-13 · App: `apps/studio` · Status: draft for review

## Why

On studio.bffless.dev the prep step "Sample & save director thumbnails" finished with
"no frames sampled" on an 18-minute, 784 MB `.mov`. The step downloads the whole source
into the tab and grabs frames with a `<video>` + canvas (`src/lib/frames.ts`
`captureFramesAt`). In that session the video element produced nothing: no error was
recorded, and the step still reported done, so the director ran with no contact sheets.
The same file captures fine in headless Chromium, so the file is not the problem. The
browser path is: it holds a whole recording in memory and fails silently.

The Workflow harness's `workflow-studio` already moved this to the server
(`video/contact-sheet` and `video/frames` rules over CE's ffmpeg `frames` operation,
ce#706, CE >= 0.4.35). The Studio app never did. Its ffmpeg work (slice, assemble,
stitch, extract audio) already has a server path, but it still keeps an ffmpeg.wasm
fallback and a Browser option.

**Decision (2026-09-13):** every video operation in Studio runs on CE's `ffmpeg_handler`.
ffmpeg.wasm and in-browser frame capture are deleted. Studio requires a CE that has the
ffmpeg `frames` operation.

## Scope

**Moves to the server** (browser-only today):

| # | Feature | Today | Server call |
|---|---|---|---|
| 1 | Prep contact sheets | `generateThumbnails`: fetch each source whole, capture, compose, upload as `thumbnails` | `POST /api/video/contact-sheet`, once per source |
| 2 | Per-scene dense sheets (refiner + cut-editor filmstrip) | `generateSceneSheets` → `captureSceneContactSheet` | `POST /api/video/contact-sheet` with the scene's times |
| 3 | Scene card midpoint thumb | `completeDirectorJob`, a 64px data URL per scene | `POST /api/video/frames` |
| 4 | Blog inline `frame:<t>` images | `materializeBlogImages`, capture then upload as `blog` | `POST /api/video/frames` (1080 px tall) |
| 5 | Blog re-frame candidate strip | `captureBlogSiblings`, 108px data URLs | `POST /api/video/frames` (small height) |
| 6 | Blog re-frame commit | `reframeBlogImage`, capture then upload | `POST /api/video/frames` (1080 px tall) |
| 7 | Blog re-frame preview | `captureBlogPreview`, one 720px data URL | Reuses #5: the candidate strip is fetched at 720px in one frames job, so a candidate's own URL is its large preview. `captureBlogPreview` returns the cached URL, falling back to a one-frame job. `BlogFigure` is unchanged, since it already renders an image URL. |

**Loses its browser fallback** (the server path already exists): scene slice, scene
assemble (manual and Auto Build), final-cut stitch (manual and Auto Build), extract audio.

**Stays in the browser, because it is not ffmpeg:** waveform peaks, dead-space
measurement and the auto-trim RMS knob, which decode the small 16 kHz WAV
(`src/lib/audio.ts`), and `measureVideoDuration` (metadata only). Scene soundtrack
slicing (`sliceAudioWav`) goes away with the wasm slice branch.

**Out of scope:** CE changes (none needed), workflow-studio, the video backend's
`local`/`remote` executor choice (kept), transcription and the AI steps.

## Delivery: two stacked PRs

### PR 1: server frames

**Rules** (studio set, `.bffless/proxy-rules/studio/rules/api/video/`). Both follow the
existing Studio video rules' shape (`slice/post`): `prep.fn.js` validates →
`data_create` job row (`$schema:studio_jobs`) → respond `{ jobId, status }`. postSteps:
setRunning → `ffmpeg_handler` → `check.fn.js` → finishOk / finishErr. The client polls
the existing `GET /api/studio/job`.

- `contact-sheet/post`, body `{ sourceUrl, projectId, times, labels, executor? }`.
  - `prep` enforces the same confinement as slice: `sourceUrl` under `/api/uploads/`, no
    `..`, and a `projectId` with no `/`. `times` must be 1–200 finite, non-negative
    numbers; `labels` must be strings, one per time.
  - The op is `operation: frames`, with `outputPrefix: projects/<pid>/thumbnails/server/<id>`,
    `times`, `draw: { text: labels, position: bottom-left, size: 0.1 }`,
    `tile: { perSheet: 12, columns: 3 }` and `executor`.
  - Job kind `video-contact-sheet`. `check` produces
    `{ sheets: [{ url, times, cols, rows, index, total }], drawn }`, where `url` is the
    `/api/uploads/<key>` serve path. A failure or empty result becomes an error job row,
    carrying `stepErrors.<step>.code` when CE supplies one.
- `frames/post`, body `{ sourceUrl, projectId, times, height, executor? }`.
  - The same `prep` checks, plus `height` as an integer between 64 and 4320.
  - The op is `operation: frames` with `outputPrefix: projects/<pid>/frames/server/<id>`,
    `times`, `height` and `executor`. No draw, no tile.
  - Job kind `video-frames`. `check` produces `{ frames: [{ time, url }] }` in request
    order.
  - One source per job. The client makes one call per source, so the rule needs none of
    workflow-studio's three-step fan-out.
- `check.fn.test.yaml` and `prep.fn.test.yaml` next to each, like `slice/post`.

**Client**
- `src/lib/serverFrames.ts` (pure, store-free, tested) holds three pieces:
  - request builders, including `sheetLabels(globalTimes)` in the clock format the
    browser sheets drew;
  - coercers `toSheetsResult(raw)` and `toFramesResult(raw)`, which throw on a missing
    `url` or zero entries;
  - `serverSheetGeometry(width, height, cols, rows)`. CE tiles with `padding=2:margin=2`,
    the same 2 px gap `cellGeometry` in `src/lib/filmstrip.ts` already assumes. The sheet
    `width`/`height` come from the uploaded JPEG's natural size, read once when the sheet
    is stored, so the cut editor's sprite crop keeps working.
- `src/store/studioApi.ts` gains `videoContactSheetStart` and `videoFramesStart`, and
  `VideoJobKind` gains both kinds. `runVideoJob` takes a result coercer instead of
  hard-wiring `toVideoResult`, so the `FFMPEG_BUSY` retry and polling are shared.
- The MSW mocks in `src/mocks/handlers.ts` return the same shapes through the same
  coercers.
- Call-site changes, one per row above:
  - **Sheet budget with several recordings.** The director and blog rules read only the
    first 10 sheet URLs (`rules/api/scenes/post/prep.fn.js:8`). Each recording's job tiles
    its own frames 12 to a sheet, so every boundary between recordings can cost one extra
    sheet. `planGlobalSheetCaptures` therefore caps the global frame count at
    `12 × (10 − (recordings − 1))`. With one recording that is 120, the same as today. For
    `k` recordings, `Σ ceil(nᵢ/12) ≤ ceil(Σnᵢ/12) + (k − 1) ≤ 10`.
  - **#1** `generateThumbnails` plans the global captures as today, groups them by source,
    starts one contact-sheet job per source (sequentially, through the existing upload/ffmpeg
    lane), then orders the sheets globally and dispatches `setContactSheets`. No browser
    upload. Zero sheets fails the step with the job's error.
  - **#2** `generateSceneSheets` does the same for one scene. It sends the scene's LOCAL
    times, read from the scene's source recording (not the cut clip), so it still doesn't
    depend on the cut step. In Auto Build (`src/lib/autoBuild.ts`) the `sheets` step moves
    from its own `sheets` lane into the `ffmpeg` lane:
    - it now runs server ffmpeg, so on the Local executor it has to share the backend's
      single slot with cut and assemble instead of racing them into `FFMPEG_BUSY`;
    - on Remote it widens with the lane, like cut and assemble.

    The `sheets` lane and its comment are removed.
  - **#3** Midpoint thumbs become frame URLs (`scene.thumb` holds a URL, not a data URL).
  - **#4 and #6** use the returned frame URL directly in the blog markdown. No re-upload.
  - **#5** returns URLs to the picker.
- Deleted in PR 1:
  - from `src/lib/frames.ts`: `captureFramesAt`, `captureFrames`, `composeContactSheet`,
    `captureContactSheet`, `captureSceneContactSheet`. The `ContactSheet` type stays
    unchanged: server sheets set `dataUrl: ''` and take `bytes` from CE's reported size,
    so no consumer or test fixture of sheets changes;
  - the unused `src/components/Studio/Filmstrip.tsx`;
  - the `pendingSheets` data-URL preview.

**Failure behaviour.** A job error or an empty result puts the stage in its error state
with the job's message, for example "Contact-sheet capture failed (FFMPEG_FAILED: …)".
"No frames sampled" as a done state is gone.

### PR 2: delete the browser video path

- Remove every `getVideoBackend() === 'wasm'` branch: `useScenePipeline.ts` extract and
  slice, `SceneAssembleBar.tsx`, `FinalCutBar.tsx`, and `useAutoBuild.ts` assemble and
  stitch. Also remove `extractAndUploadAudio` (already unreachable) and `sliceAudioWav`.
- Delete `src/lib/export/ffmpeg.ts`, `assembleScene.ts`'s wasm assemblers, the
  `@ffmpeg/*` dependencies, `scripts/patch-core-mt.mjs` with its `postinstall` and its
  CLAUDE.md section, and the `sourceBlobs` / `useSignedBytes` whole-file fetches that
  only fed wasm or canvas.
- The `.npmrc` lines (`enable-pre-post-scripts`, `package-import-method=copy`) stay only
  if another package still needs them; the plan checks.
- `src/lib/videoBackend.ts`:
  - drop `wasm` from `VideoBackend`; the picker offers Server (auto), Local server and
    Remote;
  - read a stale `?videoBackend=wasm|browser` or a stored `wasm` as `server`;
  - when the probe says `server: false` or fails, video steps fail with "This BFFless
    instance has no server video (CE ffmpeg). Studio needs it for every video step." and
    no fallback.
- Remove `BrowserSupportBanner` and the cross-origin-isolation requirement it guarded,
  keeping any header rule another app still needs. The preview workflow comment about
  COOP/COEP for ffmpeg.wasm is updated.
- Update `apps/studio/CLAUDE.md` (the locked pipeline, the backend paragraph, the core-mt
  section) and `bffless/README.md` prerequisites to say CE >= 0.4.35 with ffmpeg.

## Testing

- Rule function tests (`*.fn.test.yaml`) cover valid requests, each refusal in `prep`, and
  `check` on success, an empty result and a CE step error.
- Vitest covers the `serverFrames.ts` coercers, labels and geometry; `videoBackend.ts`
  without `wasm` (stale values map to `server`, the probe-false error); and the updated
  `useScenePipeline` stage tests. The whole suite must stay green (718 tests on the
  baseline).
- `pnpm --filter studio build`, `lint` and `test:run` all pass; the headless smoke keeps
  every `data-testid`.
- Live, after the PR 1 merge deploys to j5s: sign in with a member login (not an API key)
  and run prep on a long `.mov` (the 784 MB recording from this incident). Expect sheets
  in the stage detail and in `studio_jobs` (`video-contact-sheet` done), and the director
  job's request to carry the sheet URLs.

## Rollout

- A PR runs `preview-studio.yml`: the app deploys to `studio-preview`, and rules are only
  dry-run.
- Merging to `main` runs `deploy-studio.yml`, which pushes the studio rule sets to
  `vars.BFFLESS_URL` (admin.j5s.dev) and deploys the `studio` alias. I will ask before
  merging.
- studio.bffless.dev (the `studio` project on bffless.dev, where the failure happened) is
  an **app-catalog install**. Its live deployment is "App install: Studio v1.15.1" on
  branch `app-catalog`, and its `studio` / `studio-blog` rule sets were synced from
  `bffless/apps` `rulesets/studio.json` and `rulesets/studio-blog.json` on 2026-09-12. It
  picks up this change only after a Studio release has been published to the catalog
  (the `publish-app` flow) and the app has been updated from Admin → Apps. That update
  brings the app build and the new rules together, so the app never calls
  `/api/video/contact-sheet` before the rule exists.
- PR 2 merges after PR 1 is live and walked.
