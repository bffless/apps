# Signed downloads with a chosen filename

**Date:** 2026-07-10
**Repos:** `bffless/ce` (first), `bffless/apps` (second)
**Status:** approved, not yet implemented

## Problem

Studio's Export page has a **Download MP4** button (`FinalCutBar.tsx`). Its `href` is the
saved final cut's `/api/uploads/...` **serve path**, so every byte of a multi-hundred-MB
video is streamed out of the bucket, through the BFFless backend's `file_serve` handler,
and down to the browser. A 473 MB final cut took Chrome an estimated **19 minutes**, and
the observed download was cancelled before it finished.

Everything else in Studio already avoids this. Playback signs the serve path into a direct
bucket URL (`FinalCutBar.tsx:55`), and every ffmpeg read goes through `useSignedBytes`,
which signs first for exactly this reason (`bffless/ce#317`: `file_serve` 504s and OOMs on
big objects).

The download is the one path that doesn't, and the code says why:

```ts
// The download link keeps the serve path: `download`
// is ignored on cross-origin URLs, so signing it would cost the filename.
```

That is a real constraint, not an oversight. The download deliberately trades speed for a
filename.

## Why this needs a CE change

The "download straight from the bucket" half needs nothing new: `/api/uploads/sign` already
exists and is already used twice. The **filename** half is what forces a CE change, and
without it there is no download at all.

Four facts, all verified:

1. `<a download="…">` is ignored on cross-origin URLs. The name must arrive from the
   server as a `Content-Disposition` response header. (`FinalCutBar.tsx:52-54` and
   `ThumbnailStudio.tsx:65-67` each discovered this independently.)
2. GCS sends `Content-Disposition` only if it is stored in the object's metadata at upload
   time, or signed into the URL as the `response-content-disposition` query parameter.
3. The parameter cannot be appended client-side. GCS V4 signing covers the entire canonical
   query string. Verified against the live bucket:

   ```
   $ curl -sI "<signed-url>"
   HTTP/2 200
   content-type: video/mp4              # ← no content-disposition

   $ curl -sI "<signed-url>&response-content-disposition=attachment%3B..."
   HTTP/2 403                            # SignatureDoesNotMatch
   ```

4. The signature cannot be minted in a `function_handler` — no `crypto`.

So `response-content-disposition` can only enter the URL inside `signed_url` → `getUrl`,
and neither accepts it: `SignedUrlHandlerConfig` is `{ path, expiresIn }`
(`signed-url.handler.ts:10-21`) and `IStorageAdapter.getUrl(key, expiresIn)` has nowhere to
put it (`storage.interface.ts:123`).

**Consequence of not doing this:** navigating to a signed URL for a `video/mp4` object with
no disposition makes Chrome open its built-in video player. The user never gets a file.

### Options considered and rejected

| Option | Why not |
| --- | --- |
| Name the bucket object (`keyStrategy: 'verbatim'`) and let the browser take the name from the URL's last path segment | No `Content-Disposition` means the browser plays the video inline and never uses the name. Also freezes the name at save time. |
| Store `Content-Disposition` in the object's metadata at upload | Still a CE change (`presigned_upload` has no such option), *and* the name freezes at save time — retitling the video later wouldn't rename the download. |
| Fetch the signed URL into a `Blob`, then `URL.createObjectURL` + `download` | What `ThumbnailStudio` does today. Fine for a 137 KB JPEG; pulls 473 MB into tab memory for a video. |
| `showSaveFilePicker()` + `response.body.pipeTo(writable)` | Genuinely works and is app-only, but Chrome/Edge only. Would be Studio's first Chrome-only feature and still needs a Firefox/Safari fallback. |

## Section 1 — CE

### `storage.interface.ts`

```ts
export interface SignedUrlOptions {
  /** Force a download with this name (Content-Disposition: attachment). */
  downloadFilename?: string
}

getUrl(key: string, expiresIn?: number, options?: SignedUrlOptions): Promise<string>
```

### `signed-url.handler.ts`

`SignedUrlHandlerConfig` gains an optional `filename`. It runs through the same
`evaluateExpression` as `path`, so a rule may pass either an expression
(`steps.resolvePath.filename`) or a literal (`video.mp4`) — the evaluator returns
non-`steps.`/`request.`-rooted strings unchanged (`expression-evaluator.ts:66-69`).

The resolved value then passes through **one sanitizer**, which is the single choke point
protecting every adapter from header injection:

- reduce to a basename (strip `/` and `\`)
- drop control characters, `"`, and backslashes
- cap the length
- collapse an empty result to `undefined`

Omitting `filename` must produce a byte-identical call to today's. `useSignedBytes` signs
this same endpoint for ffmpeg reads and must not change.

### Adapters

| Adapter | Parameter |
| --- | --- |
| GCS | `promptSaveAs` (the SDK builds `attachment; filename=` from it) |
| S3 / MinIO | `ResponseContentDisposition` on the `GetObjectCommand` |
| Azure | `contentDisposition` on the SAS |
| Local | accepts and **ignores** it |

`dynamic-storage.adapter` forwards. Local cannot presign at all
(`supportsPresignedUrls(): false`), so a self-hoster on local storage keeps today's
behavior: a backend serve URL, no disposition, mp4 opens inline. This is documented in the
interface comment, not worked around — Studio's upload path is presigned direct-to-bucket
(edge nginx caps request bodies at 1 MB), so **Studio cannot run on local storage anyway**.

### CE tests

- Each adapter spec: the presign parameter is set when `downloadFilename` is present, and
  **absent** when it isn't.
- Handler spec: expression evaluation, sanitization, and the no-filename regression case.

## Section 2 — Studio

### The proxy rule (`/api/uploads/sign`)

`resolvePath` gains one more output: an optional `filename` read from
`request.body.filename`, reduced to a basename, stripped to `[A-Za-z0-9._-]`, and empty
when absent. The `sign` step passes `filename: "steps.resolvePath.filename"`.

This is backward compatible in **both** directions, which is what makes the rollout safe:

- `useSignedBytes` posts `{ url }` with no filename → resolves to `''` → `signed_url` skips
  the disposition → identical to today.
- Today's deployed CE ignores an unknown `filename` config key (`validateConfig` only
  requires `path`).

So the live `studio` rule set can be updated **before** the CE deploy lands, as a no-op.
No lockstep, no feature flag.

### The client

- **`src/lib/slug.ts`** (new): one `slugify()`. `thumbnailFileName()` moves onto it and
  switches from underscores to **hyphens**; `finalCutFileName()` joins it, falling back to
  `studio-final-cut.mp4` on an empty title.

  ```
  custom-ai-content-pipeline.jpg
  custom-ai-content-pipeline.mp4
  ```

- **`FinalCutBar`** takes a `title` prop. `Studio.tsx:580` already has
  `pipe.description?.title ?? ''` in hand — it passes exactly that to `ThumbnailStudio` and
  `BlogCard` two lines below.

- **`studioApi`** gains a second query, `signAttachment`, keyed on `{ url, filename }`.
  Kept separate from `signDownload` rather than adding a disposition to the one signature
  both share: playback would then point a `<video>` at an `attachment` URL, and while media
  elements do ignore `Content-Disposition`, inline playback shouldn't depend on that. Two
  signatures, both cached an hour; one extra pipeline call per Export render, carrying no
  bytes.

- The `<a>` **keeps** `download={finalCutFileName(title)}`. It is still load-bearing for the
  freshly-stitched case, where `downloadHref` is a same-origin `blob:` URL. On the signed
  cross-origin URL it is ignored and the header wins. Both paths produce the same name.

### Studio tests

- `slug.test.ts`: slugify + both filename helpers, including the empty-title fallback.
- `FinalCutBar` test: the `href` is the signed URL, and `signAttachment` is called with the
  slugified filename.
- MSW: `/api/uploads/sign` mock accepts and echoes `filename`.

## Rollout

1. CE PR: interface, handler, four adapters, specs. Merge, release, deploy to `j5s.dev`.
2. Update the live `studio` proxy rule set via MCP (Sandcastle does not deploy live rules).
   Re-export `bffless/studio.proxy-rules.json` and commit.
3. Studio PR: `slug.ts`, `FinalCutBar`, `studioApi`, `Studio.tsx`, mocks, tests.

## Verification

Beyond the unit tests, the whole feature is one line of output. Mint a signed URL **with** a
filename and re-run the probe from the Problem section:

```
$ curl -sI "<signed-url-with-filename>"
HTTP/2 200
content-type: video/mp4
content-disposition: attachment; filename="custom-ai-content-pipeline.mp4"
```

Then click **Download MP4** on a saved final cut and confirm the browser saves it under that
name without the request touching the backend.

## Out of scope

- Per-scene downloads (`SceneAssembleBar.tsx:179`) — same serve-path pattern, same fix, but
  tens of MB rather than hundreds.
- The thumbnail JPEG. Once CE ships this, `ThumbnailStudio`'s fetch-into-a-Blob download
  (`ThumbnailStudio.tsx:65-79`) becomes dead weight and could point at a signed attachment
  URL instead. Follow-up.
- Local storage support for `downloadFilename`. Studio cannot run on local storage.
