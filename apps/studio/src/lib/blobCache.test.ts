import { describe, it, expect, vi } from 'vitest'
import { createBlobCache } from './blobCache'

describe('createBlobCache', () => {
  it('fetches a URL once and returns the same Blob on later gets', async () => {
    const fetcher = vi.fn(async (url: string) => new Blob([url]))
    const cache = createBlobCache(fetcher)

    const first = await cache.get('/api/uploads/serve/source.mp4')
    const second = await cache.get('/api/uploads/serve/source.mp4')

    expect(second).toBe(first)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent gets for the same URL into one fetch', async () => {
    let release!: (b: Blob) => void
    const fetcher = vi.fn(() => new Promise<Blob>((resolve) => (release = resolve)))
    const cache = createBlobCache(fetcher)

    const a = cache.get('/a')
    const b = cache.get('/a')
    release(new Blob(['bytes']))

    expect(await a).toBe(await b)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('caches per URL', async () => {
    const fetcher = vi.fn(async (url: string) => new Blob([url]))
    const cache = createBlobCache(fetcher)

    const a = await cache.get('/a')
    const b = await cache.get('/b')

    expect(a).not.toBe(b)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed fetch — the next get retries', async () => {
    const fetcher = vi
      .fn<(url: string) => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Blob(['ok']))
    const cache = createBlobCache(fetcher)

    await expect(cache.get('/a')).rejects.toThrow('network down')
    await expect(cache.get('/a')).resolves.toBeInstanceOf(Blob)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
