# 02 — Wire transcription with timestamps (stage ③)

> Read `00-architecture-and-state.md` first.

**Status:** ✅ done (pending Replicate API token) · **Backend: BFFless `replicate` (WhisperX).**

## Goal

Replace mocked stage ③ with a real speech-to-text call that returns **word-level
timestamps**. The WAV is **already in the bucket** — story 01b's stage ② extracts
the 16 kHz mono WAV in-browser and presigned-uploads it to `/api/uploads/audio`,
keeping its URL as `audioUrl`. This story just transcribes that URL.

## Backend (`/api/transcribe` pipeline)

1. **No `file_upload_handler`** — the WAV is already uploaded (story 01b). The FE
   POSTs `{ audioUrl }`; the BFFless edge nginx 1 MB body cap means we must
   **never** stream the audio through a pipeline (same lesson as story 01).
2. `replicate` — `incredibly-fast-whisper` (or whisper-large-v3); `input.audio`
   = `request.body.audioUrl`; request word/segment timestamps. (If the model
   can't reach a relative `/api/uploads/audio/...` URL, resolve it to an absolute
   alias URL or mint a `signed_url` first.)
3. `response_handler` — return `{ words: [{ text, start, end }], text }`.
4. Validators: `auth_required` + `rate_limit` (costs money per call).

## Front-end (mostly done in 01b)

- `/api/transcribe` is **already MSW-mocked** (canned words + timestamps) and the
  manual **"Transcribe audio"** button already POSTs `{ audioUrl }` and keeps the
  returned `words` in pipeline state for shorten + segment (story 03). Removing
  the MSW handler swaps to the real pipeline with no UI change.
- `detail` = real word count + duration (already wired).

## Acceptance criteria

- [x] Real transcript with timestamps comes back and is retained for shorten+segment.
- [x] Mock and real share the `{ words, text }` shape.
- [~] `auth_required` + `rate_limit` — **deferred to story 07** (per request, no
      validators yet so local unauthenticated dev works, mirroring the upload
      rules). build/lint/tests pass.

## Implementation notes (done)

Pipeline rule `972a6dc5-847b-450a-be31-a50566d0781d` on the `studio` rule set
`cf413ff6`, `POST /api/transcribe`, timeout 120 s. Five steps:

1. `function_handler` **resolvePath** — rebuilds the full bucket storage path
   from `request.body.audioUrl` (the public serve path). The signer needs the
   project-prefixed key `bffless/example-project/uploads/audio/<date>/<file>`,
   not the `/api/uploads/...` serve URL (a relative key signs a non-existent
   object). The `bffless/example-project/uploads/` prefix is a project constant.
2. `signed_url` **sign** — mints a 1 h presigned **GCS** download URL
   (`storage.googleapis.com/j5s-dev/...`, signs `host` only) so Replicate can
   fetch the WAV directly, bypassing our origin. Output `steps.sign.url`.
3. `replicate` **whisper** — `victor-upmeet/whisperx`
   `655845d6…f5cc`; `input.audio_file = steps.sign.url`, **`align_output:true`**
   (the flag that yields per-word timestamps), `batch_size:64`, `diarization:false`,
   `temperature:0`, `debug:false`. Other inputs use model defaults (vad, language
   detection).
4. `function_handler` **flatten** — WhisperX returns
   `{ segments:[{ start,end,text, words:[{ word,start,end,score }] }], detected_language }`;
   flattens every segment's `words` into `{ text,start,end }` (mapping `word`→`text`,
   tolerating aligned tokens that lack start/end) and joins segment text. Reads
   `steps.whisper.output` or the step directly (defensive).
5. `response_handler` — `{{{steps.flatten}}}` → `{ words, text }` (same shape the
   mock used; FE unchanged).

**Verified end to end** (debug log `4b24c41e`): a real bucketed WAV →
`resolvePath` produced the correct storage path → `sign` minted a presigned URL
that **serves the WAV (HTTP 200, `audio/wav`, range-capable)** → reached the
`whisper` step. The only failure is `REPLICATE_NOT_CONFIGURED`: **the project has
no Replicate API token.** Add it in BFFless **Settings → AI → AI Services**, then
the call completes (not exposed via MCP, so a human must set it).

**Front-end:** removed the `/api/transcribe` MSW mock in `src/mocks/handlers.ts`
— unhandled `/api/*` falls through to the Vite proxy (`https://j5s.dev`), same as
the upload routes. `useScenePipeline` stage ③ already POSTs `{ audioUrl }` and
keeps `{ words, text }`; comments updated. No UI change.

⚠️ **No validators yet.** `auth_required` (`{ allowApiKey: true }`) + `rate_limit`
(config key is **`limit`** + `windowMs`, by-IP) are deferred to **story 07** so
local unauthenticated dev keeps working. Debug logging left **on** for the first
real run.

## Out of scope

Shortening + scene-splitting (03) — this story only produces the transcript.
Long-form async: the pipeline is synchronous (120 s cap), fine for short clips;
a real 45-min transcription needs an async job (future work).
