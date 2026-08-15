/**
 * PUT a blob with upload-progress reporting.
 *
 * `fetch()` gives no visibility into how many bytes of a request body have gone
 * out, so a 300 MB file looked identical to a hung one. `XMLHttpRequest` is the
 * only browser API that reports *upload* progress, so the presigned bucket PUTs
 * (ADR-0001: bytes go straight to the bucket, no proxy, no credentials) use it
 * instead. Everything else — prepare, register — stays on the RTK Query
 * baseQuery, since those are small metadata calls.
 *
 * Resolves `{ ok, status }` (mirroring the `Response` fields the callers used)
 * so a non-2xx stays a value, not a throw. Only a network failure or an abort
 * rejects; `isAbortError` distinguishes a user cancel from a real failure.
 */

export interface PutProgressOptions {
  /** Called with (loaded, total) as bytes leave the socket. */
  onProgress?: (loaded: number, total: number) => void
  /** Aborts the transfer; the promise then rejects with an abort error. */
  signal?: AbortSignal
}

const ABORT_MESSAGE = 'Upload canceled'

function abortError(): Error {
  const err = new Error(ABORT_MESSAGE)
  err.name = 'AbortError'
  return err
}

/** True for the rejection `putWithProgress` raises when a transfer is aborted. */
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

export function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  { onProgress, signal }: PutProgressOptions = {},
): Promise<{ ok: boolean; status: number }> {
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    const onSignalAbort = () => xhr.abort()
    const cleanup = () => signal?.removeEventListener('abort', onSignalAbort)

    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', contentType)

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        // A chunked/unknown-length body reports no total — nothing to show.
        if (e.lengthComputable) onProgress(e.loaded, e.total)
      }
    }
    xhr.onload = () => {
      cleanup()
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status })
    }
    xhr.onerror = () => {
      cleanup()
      reject(new Error('Upload failed: network error'))
    }
    xhr.ontimeout = () => {
      cleanup()
      reject(new Error('Upload failed: timed out'))
    }
    xhr.onabort = () => {
      cleanup()
      reject(abortError())
    }

    signal?.addEventListener('abort', onSignalAbort)
    xhr.send(body)
  })
}
