/**
 * A tiny session-scoped Blob cache keyed by URL — built for the media the Build
 * phase reads over and over. Every per-scene step used to pull the ENTIRE source
 * recording back from the bucket (the cut, then the dense sheets — twice per
 * scene, ~12 full downloads of an hour-long recording per 6-scene Auto Build);
 * caching the fetched Blob turns that into one download per source. Blobs are
 * disk-backed by the browser, so holding a multi-GB source costs blob storage,
 * not JS heap — the same reason `slice()` mounts a Blob instead of copying it.
 *
 * The cache stores the fetch PROMISE, not the settled Blob, so two steps racing
 * for the same URL share one in-flight download. A failed fetch is evicted so
 * the next get retries instead of replaying the error forever.
 */
export function createBlobCache(fetcher: (url: string) => Promise<Blob>): {
  get: (url: string) => Promise<Blob>
  clear: () => void
} {
  const cache = new Map<string, Promise<Blob>>()
  return {
    get(url: string): Promise<Blob> {
      const hit = cache.get(url)
      if (hit) return hit
      const pending = fetcher(url).catch((e: unknown) => {
        cache.delete(url)
        throw e
      })
      cache.set(url, pending)
      return pending
    },
    clear() {
      cache.clear()
    },
  }
}
