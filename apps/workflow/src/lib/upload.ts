/**
 * `uploadFile` (06): the prepare → PUT → register flow, as one function. The
 * kickoff form uploads on select (08) and the `form` step's file control
 * (M2) drives the same three calls under a different `scope`.
 *
 * `prepare`/`register` go through `httpJson` (same-origin JSON, no retries —
 * see `lib/http`); the PUT itself is a raw `XMLHttpRequest` because that is
 * the only way the browser reports upload progress.
 */
import { toFileRef } from './coerce'
import { httpJson } from './http'
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

async function prepare(a: UploadFileArgs): Promise<Prepared> {
  const res = await httpJson('/api/workflow/files/prepare', {
    method: 'POST',
    signal: a.signal,
    body: {
      impl: a.impl,
      workflow: a.workflow,
      scope: a.scope,
      filename: a.file.name,
      contentType: a.file.type,
      size: a.file.size,
    },
  })
  if (!res.ok) throw new Error(`files/prepare answered ${res.status}`)
  return toPrepared(res.body)
}

/** The direct-to-bucket PUT. Plain `fetch` cannot report upload progress. */
function putFile(
  url: string,
  file: File,
  signal: AbortSignal | undefined,
  onProgress: ((fraction: number) => void) | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()

    xhr.open('PUT', url, true)
    if (file.type) xhr.setRequestHeader('content-type', file.type)

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

    xhr.send(file)
  })
}

async function register(a: UploadFileArgs, storageKey: string): Promise<FileRef> {
  const res = await httpJson('/api/workflow/files/register', {
    method: 'POST',
    signal: a.signal,
    body: {
      impl: a.impl,
      workflow: a.workflow,
      scope: a.scope,
      storageKey,
      originalName: a.file.name,
    },
  })
  if (!res.ok) throw new Error(`files/register answered ${res.status}`)
  return toFileRef(res.body)
}

export async function uploadFile(a: UploadFileArgs): Promise<FileRef> {
  const { uploadUrl, storageKey } = await prepare(a)
  await putFile(uploadUrl, a.file, a.signal, a.onProgress)
  return register(a, storageKey)
}
