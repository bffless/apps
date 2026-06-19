# 01 — Wire the upload → bucket pipeline (stage ①)

> Read `00-architecture-and-state.md` first.

**Status:** ▶ next up · **Backend: BFFless `file_upload` → storage.**

## Goal

Replace the mocked stage ① with a real upload of the source clip to a BFFless
storage bucket, returning a stored URL the later stages (transcribe, plan,
render) can reference.

## Backend (`/api/uploads/source` pipeline)

1. `file_upload_handler` — accept the video (large `maxFileSize`, allowed MIME
   `video/*`), date-bucketed storage.
2. `response_handler` — return `{ url }` (or `{ record: { url } }`) — match the
   flexible shape `ContactDialog` already reads.
3. Validator: `auth_required` (TODO: gate behind billing in story 07).

For very large files, consider a `signed_url` direct-to-storage upload instead
of streaming through the pipeline — note which you chose and why.

## Front-end

- Mock `/api/uploads/source` in `src/mocks/handlers.ts` first.
- In `useScenePipeline.ts`, change the `upload` stage from a `delay` to a real
  `fetch('/api/uploads/source', { method:'POST', credentials:'include', body: fd })`,
  set `detail` to the stored size/URL, and keep the returned `url` in pipeline
  state (later stages will need it server-side).
- Surface upload progress if easy (XHR `progress`), else keep the spinner.

## Acceptance criteria

- [ ] Importing a clip and running uploads it to storage; stage ① shows the real
      size and completes; the URL is retained for downstream stages.
- [ ] Mock and real return the same shape (swap, don't rewrite the UI).
- [ ] `auth_required` on the pipeline; build/lint/tests pass.

## Out of scope

Transcription (02), billing gate (07 — leave a TODO at `auth_required`).

## Implementation notes (done)

- **Why not streaming `file_upload_handler`:** the BFFless edge nginx caps
  request bodies at **1 MB** (`client_max_body_size`) on *every* upload route
  and alias (proven: 1000 KB→200, 1024 KB→413; the existing contact-attachments
  route 413s too). Any real video is far over 1 MB, so streaming through a
  pipeline always 413s. The first attempt (streaming rule `c268d337`) was
  **deleted** for this reason.
- **Backend — presigned direct-to-bucket flow** (BFFless `presigned_upload` +
  `register_upload`, `studio` rule set `cf413ff6`, reusing schema
  `studio_source` `8afd205a`, GET serve `/api/uploads/source/*`):
  - `POST /api/uploads/source/prepare` (rule `5c50f027`) — `presigned_upload`,
    `subDir:"source"`, date-bucketed, 2 GB, `["video/*"]`. Returns
    `{ uploadUrl, storageKey, originalName, publicPath, expiresAt }`.
  - `POST /api/uploads/source/register` (rule `e2589fb8`) — `register_upload`,
    same `schemaId`/`subDir`; verifies the bucket object and writes the record
    **flat at top level** (`{ url, storage_path, size, … }`).
  - Storage is **GCS**; the signed PUT URL signs only `host`. Verified end to
    end via curl (3 MB PUT → 200 → register record).
- **⚠️ Bucket CORS:** the browser PUT goes straight to
  `storage.googleapis.com` from the site origin, so the bucket must allow `PUT`
  from `http://localhost:5173` (and the prod origin). curl ignores CORS; the
  browser does not. If the PUT fails with a CORS error, the bucket CORS needs
  configuring (platform-side — not exposed via MCP).
- **⚠️ `auth_required` temporarily off** on both `prepare` (`5c50f027`) and
  `register` (`e2589fb8`) so local unauthenticated dev works. **Story 07 must
  restore it:** `validators: [{ type: "auth_required", config: { allowApiKey:
  true } }]` on both rules.
- **Front-end:** `useScenePipeline.ts` stage ① does prepare → direct PUT to
  `uploadUrl` (no credentials, `Content-Type: file.type`) → register, parses
  `url` flexibly, keeps it as `sourceUrl`. No MSW handler — unhandled `/api/*`
  bypasses to the Vite proxy.
- **Dev proxy:** `vite.config.ts` points `/api` + `/_bffless` at
  `https://j5s.dev`. The `studio` rule set is attached to **both** the `preview`
  and `production` aliases.

## Addendum (2026-06-10): signed downloads — `POST /api/uploads/sign`

Reading a big object back has the same constraint as writing one: the
`file_serve` route (`GET /api/uploads/source/*`, rule `b22c0d1a`) streams the
object **through the backend**, which 504s/OOM-kills the 192 MiB-capped node
process on a ~280 MB source (platform bug, range path has no backpressure:
[bffless/ce#317](https://github.com/bffless/ce/issues/317)).

- `POST /api/uploads/sign` (rule `1ffbbbaf`) — `function_handler` resolvePath
  (restricts to `/api/uploads/*`, strips traversal) → `signed_url` (1 h) →
  `{ url, expiresIn }`. Mirrors the transcribe rule's resolvePath→sign steps.
- Front-end: `signDownload` RTK Query endpoint (`studioApi.ts`, coerced by
  `toSignedUrl` in `lib/upload.ts`); **every** read of the raw source goes
  through it — `rehydrateClip` + the restored-session preview `<video>`
  (`Studio.tsx`), per-scene sheet capture + clip slicing (`useScenePipeline`).
  Bucket reads are `fetch(signed)` with **no credentials**. Small assets
  (sheets, audio, narration, clips) still use the serve routes.
- Bucket CORS already allows `GET` from `localhost:5173` and the prod origins
  (verified via preflight) — needed for `<video crossOrigin="anonymous">`
  frame capture off the signed URL.
- **⚠️ `auth_required` off** here too (same local-dev carve-out) — story 07
  restores it alongside prepare/register.
