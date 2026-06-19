# 00c — Redux state + localStorage persistence + RTK Query (infra)

> **📍 Type:** cross-cutting infra, not a pipeline stage. Read
> `00-architecture-and-state.md` first. This story is what makes every other
> story's progress **survive a hard reload** while iterating with mocks.

## Why

Iterating on `/studio` meant re-uploading and re-processing a clip on every
reload — all the business state lived in component-local `useState`
(`useScenePipeline.ts` + `Studio.tsx`) and vanished on refresh. The producer's
pain was "I keep losing where I'm at." This moves durable state into Redux
Toolkit, persists it to **localStorage** via redux-persist, routes `/api/*`
through **RTK Query**, and turns **mock mode on** so iteration is free and offline.

## What persists vs. what doesn't

- **Persisted (Redux `studio` slice → localStorage, key `persist:studio`):** stage
  progress (the stepper + prep board), scenes, transcript words,
  `sourceUrl`/`audioUrl` (the relative `/api/uploads/...` **serve paths** that
  proxy to the bucket — never raw bucket URLs), contact sheets (post-upload, so
  `dataUrl` is already emptied to `''` and only the small `url` remains),
  `selectedId`, `duration`, `fileName`.
- **Transient (React `useState`, fine to lose):** the in-memory source `File` /
  object URL, `currentTime`, and the `running` / `voicingId` spinners.
- **The raw video blob is never stored.** It lives in memory only until stage ①
  uploads it; after that the persisted serve reference is enough to render it.

## Layout

- `src/store/studioSlice.ts` — the persisted business state + reducers
  (`patchStage`, `failActiveStage`, `setScenes`/`patchScene`, `setSourceUrl`,
  `setAudioUrl`, `setContactSheets`, `setWords`, `setSelected`, `setDuration`,
  `setFileName`, `resetStudio`). `freshStages()` (was in the hook) lives here.
- `src/store/studioApi.ts` — RTK Query: `transcribe` (JSON mutation) and `upload`
  (`{ file, kind }`) whose `queryFn` wraps the existing `presignedUpload`
  (prepare → bucket PUT → register) so the 3-step flow stays a single mutation.
- `src/store/index.ts` — `configureStore` + redux-persist. Storage is a tiny
  inline localStorage adapter (avoids the `redux-persist/lib/storage` CJS
  default-export interop bug under Vite — "storage.getItem is not a function").
- `src/store/hooks.ts` — typed `useAppDispatch` / `useAppSelector`.
- `src/main.tsx` — `<Provider>` + `<PersistGate>` wrap the app.

## Behaviour on reload

- The stepper (`studioPhase`) now takes `hasSource` (`file || sourceUrl`), so it
  reflects saved progress instead of dropping to Import when the File is gone.
- The `<video>` src falls back to the persisted serve path when the local object
  URL is absent. In **mock mode that serve path won't return real bytes**, so the
  preview can be blank after reload — acceptable; state restoration is the point.
- **Auto-rehydrate (live):** the raw clip bytes live only in memory and are gone
  after reload, but the remaining browser steps (extract audio, capture frames)
  need them. When a prep step runs without a clip in memory, `Studio.tsx`
  `rehydrateClip()` fetches `sourceUrl` → `Blob` → `File` and proceeds (the step
  uses a temp object URL that's revoked after; the preview uses the persisted
  one). No prompt. The `RestoreBanner` is now a **fallback** shown only if that
  fetch fails. "Start over" / picking a different clip dispatches `resetStudio`.

## Mocks

`MOCK_STUDIO = true` in `src/mocks/handlers.ts` (uploads + `/api/transcribe`
return fixtures). Flip to `false` to exercise the live pipelines.

## Tests

`src/store/studioSlice.test.ts` covers the reducers + reset. `studioPhase` test
updated for the `hasSource` param. Network logic stays in `presignedUpload`
(`upload.test.ts`) and is reused by the RTK Query `queryFn`, so its coverage holds.
