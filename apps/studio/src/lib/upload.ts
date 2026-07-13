/**
 * Presigned direct-to-bucket upload.
 *
 * A real video (or its extracted WAV) is far larger than the 1 MB body cap the
 * BFFless edge nginx enforces on every upload route, so streaming the bytes
 * through a pipeline always 413s. Instead we use BFFless's presigned flow:
 *
 *   1. prepare  → POST `${basePath}/prepare`, mint a presigned PUT URL (small
 *                 JSON, goes through the proxy)
 *   2. PUT      → the file bytes go straight to the storage bucket (no proxy,
 *                 no credentials — it's a presigned bucket URL, not our origin)
 *   3. register → POST `${basePath}/register`, verify the object + write the
 *                 upload record; the response is the record flat at top level
 *
 * The same flow serves both the source video (`/api/uploads/source`) and the
 * extracted audio (`/api/uploads/audio`); `basePath` selects the route.
 *
 * NOTE: the bucket must allow PUT from the site origin (CORS) or the browser
 * blocks step 2. The studio upload routes require auth — an unauthenticated
 * `POST ${basePath}/prepare` returns 401; `fetchWithReauth` refreshes the
 * session on a 401 before retrying.
 *
 * Step 2 is a single-shot `PUT` of the whole file over one TCP stream. Scene
 * clips come out of ffmpeg.wasm at hundreds of megabytes, and a flaky uplink
 * can reset that stream mid-flight (Firefox: `NS_ERROR_NET_RESET`, 0 B
 * transferred) — which surfaces as a raw "NetworkError" that reads like CORS.
 * We retry the PUT on a transport reset, **re-minting the URL each attempt** so
 * a long upload plus retries can't outlive the 3600s signature and 403. An HTTP
 * status (403 signature, 413 too big) is deterministic, so it fails fast.
 */

import { fetchWithReauth } from './auth'

/** The `/api/uploads/sign` response — read flexibly like RegisterResponse. */
type SignResponse = {
  url?: string
  data?: { url?: string }
}

/**
 * Coerce the `/api/uploads/sign` response into the signed download URL. Mock and
 * real both pass through here (the swap-don't-rewrite shape contract). Throws if
 * there's no usable URL so callers surface a real error instead of fetching ''.
 */
export function toSignedUrl(raw: unknown): string {
  const res = (raw ?? {}) as SignResponse
  const url = res.url ?? res.data?.url
  if (typeof url !== 'string' || url === '') {
    throw new Error('Sign response missing url')
  }
  return url
}

/**
 * Is this URL a persisted `/api/uploads/...` bucket serve path — i.e. something
 * `/api/uploads/sign` can swap for a direct bucket URL? Anything else (an
 * already-signed bucket URL, a transient `data:`/`blob:` URL, a non-upload API
 * route) must be fetched as-is.
 */
export function isUploadServePath(url: string): boolean {
  return url.startsWith('/api/uploads/') && !url.startsWith('/api/uploads/sign')
}

/**
 * Hard ceiling for a source video. The binding limit is the **browser**, not the
 * bucket: `extractAudio` (src/lib/audio.ts) decodes the whole file with the Web
 * Audio API, and `decodeAudioData` hard-rejects any buffer over ~2 GB ("Argument
 * 1 can't be an ArrayBuffer or an ArrayBufferView larger than 2 GB"). So we cap
 * here — before the multi-GB upload even starts — and keep the
 * `/api/uploads/source/{prepare,register}` rule `maxFileSize` in sync. Longer
 * recordings are meant to be split into multiple clips, not handled by lifting
 * this limit (the planned multi-video flow).
 */
export const MAX_SOURCE_BYTES = 2 * 1024 ** 3 // 2 GiB — the Web Audio decode ceiling

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`

/**
 * Validate a picked source file before any upload starts. Returns a
 * human-readable reason it can't be used, or `null` when it's good to go. Pure +
 * unit-tested; the import UI just renders the returned string.
 */
export function sourceFileError(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('video/')) {
    return 'That doesn’t look like a video file.'
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return `That clip is ${gib(file.size)} — the limit is ${gib(MAX_SOURCE_BYTES)}. Trim or compress it and try again.`
  }
  return null
}

type PrepareResponse = {
  uploadUrl?: string
  storageKey?: string
  originalName?: string
}

/** A minted presigned PUT target — a prepare response with its URL validated. */
type MintedUpload = PrepareResponse & { uploadUrl: string; storageKey: string }

/** Tuning knobs for the bucket PUT retry; defaulted, overridden in tests. */
export type PresignedUploadOptions = {
  /** Max PUT attempts, each re-minting the URL, before giving up. Default 3. */
  maxPutAttempts?: number
  /** Delay before the next attempt, given the 1-based attempt that just failed. */
  backoff?: (attempt: number) => Promise<void>
}

const DEFAULT_MAX_PUT_ATTEMPTS = 3

/** Exponential backoff: 250ms, 500ms, 1s, … before re-minting and re-PUTting. */
const defaultBackoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))

/** Mint a fresh presigned PUT URL via `${basePath}/prepare`. */
async function mintUploadUrl(basePath: string, file: File, projectId: string): Promise<MintedUpload> {
  const prepRes = await fetchWithReauth(`${basePath}/prepare`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, projectId }),
  })
  if (!prepRes.ok) throw new Error(`Upload prepare failed (${prepRes.status})`)
  const prep = (await prepRes.json()) as PrepareResponse
  if (!prep.uploadUrl || !prep.storageKey) {
    throw new Error('Prepare response missing uploadUrl/storageKey')
  }
  return prep as MintedUpload
}

/** The register response — the upload record, read flexibly like ContactDialog. */
type RegisterResponse = {
  url?: string
  data?: { url?: string }
  record?: { url?: string }
}

/**
 * Upload `file` to a storage bucket via the presigned flow at `basePath`
 * (e.g. `/api/uploads/source`). `projectId` is sent to the prepare and
 * register rules, which interpolate it into the per-project storage key
 * (`uploads/projects/<projectId>/<type>/...`). Throws with a descriptive
 * message if any step fails.
 */
export async function presignedUpload(
  file: File,
  basePath: string,
  projectId: string,
  options: PresignedUploadOptions = {},
): Promise<string> {
  if (!projectId) throw new Error('presignedUpload: projectId is required')

  const maxPutAttempts = options.maxPutAttempts ?? DEFAULT_MAX_PUT_ATTEMPTS
  const backoff = options.backoff ?? defaultBackoff

  // Mint a URL and PUT the bytes straight to the bucket (no `credentials` — it's
  // a presigned URL). A transport reset rejects out of `fetch` itself; retry it
  // with a freshly minted URL. An HTTP status is deterministic — fail fast.
  let prep: MintedUpload | undefined
  let lastResetError: unknown
  for (let attempt = 1; attempt <= maxPutAttempts; attempt++) {
    const minted = await mintUploadUrl(basePath, file, projectId)
    let putRes: Response
    try {
      putRes = await fetch(minted.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      })
    } catch (err) {
      // fetch rejected — a connection reset, not an HTTP status. Retryable.
      lastResetError = err
      if (attempt < maxPutAttempts) await backoff(attempt)
      continue
    }
    if (!putRes.ok) throw new Error(`Bucket upload failed (${putRes.status})`)
    prep = minted
    break
  }
  if (!prep) {
    // Rethrow the raw NetworkError as a clear message so it stops reading as CORS.
    throw new Error(`Bucket upload failed: connection reset after ${maxPutAttempts} attempts`, {
      cause: lastResetError,
    })
  }

  const regRes = await fetchWithReauth(`${basePath}/register`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storageKey: prep.storageKey,
      originalName: prep.originalName ?? file.name,
      projectId,
    }),
  })
  if (!regRes.ok) throw new Error(`Upload register failed (${regRes.status})`)
  const reg = (await regRes.json()) as RegisterResponse
  const url = reg.url ?? reg.data?.url ?? reg.record?.url
  if (!url) throw new Error('Register response missing url')
  return url
}
