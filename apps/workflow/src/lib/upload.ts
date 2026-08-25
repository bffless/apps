/**
 * `uploadBlob` (06): the prepare → PUT → register flow, as one function. The
 * kickoff form uploads on select (08), the `form` step's file control (M2)
 * drives the same three calls under a different `scope`, and a `script`
 * step's returned `Blob`/`File` output (03) uploads through it too —
 * `uploadFile` is the `File`-specific one-liner over it.
 *
 * `prepare`/`register` go through `httpJsonWithReauth`: a run (and its lease
 * heartbeat) genuinely outlives a SuperTokens access token, and a kickoff
 * upload can just as easily land after an expired session — before this it
 * went through the no-retry `httpJson`, so an upload after an expired session
 * refreshed nothing and just failed (M1 minor). The PUT itself is a raw
 * `XMLHttpRequest` because that is the only way the browser reports upload
 * progress.
 */
import { toFileRef } from './coerce'
import { httpJsonWithReauth } from './http'
import type { FileRef } from './runner/types'

export interface UploadFileArgs {
  impl: string
  workflow: string
  /** `'inputs'` (kickoff/form) or `` `runs/${runId}/${stepKey}` `` (step files). */
  scope: string
  file: File
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/** As `UploadFileArgs`, but for a script's returned `Blob`/`File` — a bare `Blob` has no `.name` of its own. */
export type UploadBlobArgs = Omit<UploadFileArgs, 'file'> & { blob: Blob; name: string }

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

interface Prepared {
  uploadUrl: string
  storageKey: string
}

/** The rule may answer `{uploadUrl,storageKey}` or the shorter `{url,key}` (06). */
function toPrepared(raw: unknown): Prepared {
  const r = (raw ?? {}) as Record<string, unknown>
  const uploadUrl = str(r.uploadUrl) ?? str(r.url)
  const storageKey = str(r.storageKey) ?? str(r.key)
  if (!uploadUrl || !storageKey) {
    throw new Error('files/prepare did not answer an upload url and storage key')
  }
  return { uploadUrl, storageKey }
}

async function prepare(a: UploadBlobArgs): Promise<Prepared> {
  const res = await httpJsonWithReauth('/api/workflow/files/prepare', {
    method: 'POST',
    signal: a.signal,
    body: {
      impl: a.impl,
      workflow: a.workflow,
      scope: a.scope,
      filename: a.name,
      contentType: a.blob.type,
      size: a.blob.size,
    },
  })
  if (!res.ok) throw new Error(`files/prepare answered ${res.status}`)
  return toPrepared(res.body)
}

/** The direct-to-bucket PUT. Plain `fetch` cannot report upload progress. */
function putFile(
  url: string,
  blob: Blob,
  signal: AbortSignal | undefined,
  onProgress: ((fraction: number) => void) | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()

    xhr.open('PUT', url, true)
    if (blob.type) xhr.setRequestHeader('content-type', blob.type)

    xhr.upload.addEventListener('progress', (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total)
    })
    xhr.addEventListener('load', () => {
      signal?.removeEventListener('abort', onAbort)
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`upload PUT answered ${xhr.status}`))
    })
    xhr.addEventListener('error', () => {
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('the upload PUT failed'))
    })
    xhr.addEventListener('abort', () => {
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('The upload was aborted', 'AbortError'))
    })

    if (signal) {
      if (signal.aborted) {
        xhr.abort()
        return
      }
      signal.addEventListener('abort', onAbort)
    }

    xhr.send(blob)
  })
}

async function register(a: UploadBlobArgs, storageKey: string): Promise<FileRef> {
  const res = await httpJsonWithReauth('/api/workflow/files/register', {
    method: 'POST',
    signal: a.signal,
    body: {
      impl: a.impl,
      workflow: a.workflow,
      scope: a.scope,
      storageKey,
      originalName: a.name,
    },
  })
  if (!res.ok) throw new Error(`files/register answered ${res.status}`)
  return toFileRef(res.body)
}

export async function uploadBlob(a: UploadBlobArgs): Promise<FileRef> {
  const { uploadUrl, storageKey } = await prepare(a)
  await putFile(uploadUrl, a.blob, a.signal, a.onProgress)
  return register(a, storageKey)
}

export async function uploadFile(a: UploadFileArgs): Promise<FileRef> {
  return uploadBlob({ ...a, blob: a.file, name: a.file.name })
}
