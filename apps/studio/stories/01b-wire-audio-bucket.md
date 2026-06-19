# 01b — Stepper, manual prep, & extract→upload-audio (stage ②)

> Read `00-architecture-and-state.md` first.

**Status:** ✅ done · **Backend: BFFless presigned (mirrors story 01).**

## Goal

Two things, born from the producer being confused about *where they are* in the
flow:

1. **A stepper.** A top-level macro stepper (Import → Prep → Build → Export) for
   orientation, with the prep board underneath as the per-step checklist.
2. **Manual, step-by-step prep.** Replace the one-shot "Analyze & segment"
   auto-run with deliberate per-step actions. The next real step is **extract the
   audio (browser) and upload that WAV to the bucket on its own** so Replicate can
   transcribe it (stage ② → an `audioUrl`). Then a manual **"Transcribe audio"**
   button (still mocked here; real whisper = story 02).

## Front-end (done)

- **Stepper:** `studioPhase()` + `PHASES` in `src/lib/pipeline.ts` derive the
  macro phase purely from `{ hasFile, ready, allBuilt }`; rendered by
  `src/components/Studio/StudioStepper.tsx`.
- **Manual prep:** `useScenePipeline` exposes `currentStageId` + `next(ctx)` (runs
  only the current step, marks the active stage `error` on throw). `STAGE_DEFS`
  gained `actionLabel` per manual step; `where` gained `'browser+pipeline'` for
  the hybrid extract+upload step. `PipelineBoard`/`StageCard` render the action
  button on the current step only.
- **Reusable upload:** the presigned prepare→PUT→register flow was lifted out of
  the old `run()` into `src/lib/upload.ts` `presignedUpload(file, basePath)`
  (unit-tested), now called twice: `/api/uploads/source` (video) and
  `/api/uploads/audio` (WAV). Stage ② extracts the WAV (`extractAudioWav`), wraps
  it as an `audio/wav` `File`, uploads it, and keeps `audioUrl` in state.
- **Transcribe (mocked):** `/api/transcribe` MSW handler returns canned
  `{ words, text }`; the button POSTs `{ audioUrl }` and retains `words`.
- Verified: `npm run build` ✓, `npm run test:run` ✓ (new `upload.test.ts` +
  `studioPhase`/`STAGE_DEFS` tests), lint clean for new code. (A pre-existing lint
  error in `ChatPopup/ChatPanel.tsx` is unrelated to this work.)

## Backend (done)

Mirrors story 01's source route for audio on the `studio` rule set
`cf413ff6-4989-44a6-afc9-75c3545b5e8e`. Reuses schema `studio_source` `8afd205a`
(the register fields are file-type agnostic; the `audio/` subDir distinguishes
records). Three rules, created on 2026-06-05 (auth temporarily off):

- `POST /api/uploads/audio/prepare` (rule `3131ba4b`) — `presigned_upload`,
  `subDir:"audio"`, `filename:request.body.filename`, `dateBucket:true`,
  `maxFileSize:2147483648`, `allowedMimeTypes:["audio/*"]` →
  `response_handler {{{steps.prepare}}}`.
- `POST /api/uploads/audio/register` (rule `f0126552`) — `register_upload`,
  `subDir:"audio"`, `schemaId:8afd205a-…`, `storageKey:request.body.storageKey`,
  `originalName:request.body.originalName`, `allowedMimeTypes:["audio/*"]` →
  `response_handler {{{steps.register}}}`.
- `GET /api/uploads/audio/*` (rule `1c1c6d16`) — `file_serve_handler`
  `subDir:"audio"`, so Replicate can fetch the WAV in story 02.

Storage is **GCS**; the signed PUT URL signs only `host`. **Verified end to end
via curl** (prepare → 3 MB-style PUT 200 → register wrote a record
`content_type:audio/wav` → GET serve 200).

⚠️ **`auth_required` temporarily off** on prepare/register (consistent with
source — local unauthenticated dev). Story 07 restores it on the audio rules too.
Bucket CORS already allows PUT from the site origin (same GCS bucket as source) —
no new CORS config.

## Acceptance criteria

- [x] Stepper shows the macro phase; prep runs step by step with per-step buttons.
- [x] Stage ② extracts the WAV and (FE) uploads it via the presigned flow,
      retaining `audioUrl`; `presignedUpload` shared with the video upload.
- [x] `/api/uploads/audio/*` rules exist; an end-to-end run writes a record and
      the WAV serves back (verified via curl: prepare → PUT 200 → register → GET 200).
- [x] build/lint(new)/tests pass.

## Out of scope

Real Replicate transcription (02), shorten/segment/clone wiring (03/04), billing
gate (07 — restore `auth_required` on the audio rules there).
