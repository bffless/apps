import { useCallback } from 'react'
import { useLazySignDownloadQuery } from '../../store/studioApi'
import { fetchWithReauth } from '../../lib/auth'
import { isUploadServePath } from '../../lib/upload'

/**
 * Fetch a media URL into raw bytes for ffmpeg's virtual FS, swapping any
 * persisted `/api/uploads/...` serve path for a time-limited **direct bucket
 * URL** first (`/api/uploads/sign`). The serve pipeline streams objects through
 * the BFFless backend, which is slow for the multi-hundred-MB scene clips and
 * 504s/OOMs on the biggest ones (bffless/ce#317) — same reason every read of
 * the raw source already goes through `signedSourceUrl` in useScenePipeline.
 * `preferCacheValue` reuses a signature across re-assembles within its 1 h life.
 *
 * Non-serve URLs (`data:`/`blob:`, already-signed bucket URLs) fetch as-is.
 * Note the credentials split: same-origin serve paths need the session cookie
 * (and go through `fetchWithReauth`, so an access token that expired mid-build
 * refreshes and retries rather than failing the read), but a signed bucket URL
 * must NOT send credentials — a credentialed cross-origin request would fail the
 * bucket's CORS check, and its 401s aren't session errors anyway.
 */
export function useSignedBytes() {
  const [signReq] = useLazySignDownloadQuery()

  return useCallback(
    async (url: string): Promise<Uint8Array> => {
      const signed = isUploadServePath(url)
      const resolved = signed ? (await signReq(url, true).unwrap()).url : url
      const res = signed ? await fetch(resolved) : await fetchWithReauth(resolved)
      if (!res.ok) throw new Error(`Couldn't load ${url} (${res.status})`)
      return new Uint8Array(await res.arrayBuffer())
    },
    [signReq],
  )
}
