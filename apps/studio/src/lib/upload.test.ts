import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  presignedUpload,
  toSignedUrl,
  isUploadServePath,
  sourceFileError,
  MAX_SOURCE_BYTES,
} from './upload'

afterEach(() => vi.restoreAllMocks())

function mockFetchSequence() {
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url, body })
    if (url.endsWith('/prepare')) {
      return new Response(JSON.stringify({ uploadUrl: 'https://bucket/put', storageKey: 'projects/p1/source/d/u-f.mov', originalName: 'f.mov' }), { status: 200 })
    }
    if (url.startsWith('https://bucket/')) return new Response(null, { status: 200 })
    if (url.endsWith('/register')) {
      return new Response(JSON.stringify({ url: '/api/uploads/projects/p1/source/d/u-f.mov' }), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }))
  return calls
}

describe('presignedUpload threads projectId', () => {
  it('sends projectId in BOTH the prepare and register bodies', async () => {
    const calls = mockFetchSequence()
    const file = new File([new Uint8Array([1, 2, 3])], 'f.mov', { type: 'video/quicktime' })
    const url = await presignedUpload(file, '/api/uploads/source', 'p1')
    expect(url).toBe('/api/uploads/projects/p1/source/d/u-f.mov')
    const prep = calls.find((c) => c.url.endsWith('/prepare'))!.body as Record<string, unknown>
    const reg = calls.find((c) => c.url.endsWith('/register'))!.body as Record<string, unknown>
    expect(prep.projectId).toBe('p1')
    expect(prep.filename).toBe('f.mov')
    expect(reg.projectId).toBe('p1')
    expect(reg.storageKey).toBe('projects/p1/source/d/u-f.mov')
  })

  it('throws when projectId is empty (defensive — uploads are always project-scoped)', async () => {
    mockFetchSequence()
    const file = new File([new Uint8Array([1])], 'f.mov', { type: 'video/quicktime' })
    await expect(presignedUpload(file, '/api/uploads/source', '')).rejects.toThrow(/projectId/)
  })
})

describe('isUploadServePath', () => {
  it('matches persisted relative /api/uploads/ serve paths', () => {
    expect(isUploadServePath('/api/uploads/voice/2026-06-12/x-original-77-79.wav')).toBe(true)
    expect(isUploadServePath('/api/uploads/scene-clip/2026-06-12/clip.mp4')).toBe(true)
  })

  it('passes through everything that is not a serve path', () => {
    expect(isUploadServePath('https://storage.googleapis.com/bucket/x.wav?X-Goog-Signature=abc')).toBe(false)
    expect(isUploadServePath('data:audio/wav;base64,UklGRg==')).toBe(false)
    expect(isUploadServePath('blob:http://localhost:5173/123-abc')).toBe(false)
    expect(isUploadServePath('/api/scenes')).toBe(false)
  })
})

describe('sourceFileError', () => {
  it('accepts a video within the size limit', () => {
    expect(sourceFileError({ type: 'video/mp4', size: 500_000_000 })).toBeNull()
    expect(sourceFileError({ type: 'video/quicktime', size: MAX_SOURCE_BYTES })).toBeNull()
  })

  it('rejects non-video files', () => {
    expect(sourceFileError({ type: 'image/png', size: 1000 })).toMatch(/video file/)
    expect(sourceFileError({ type: '', size: 1000 })).toMatch(/video file/)
  })

  it('rejects a video over the 2 GiB Web Audio limit before it uploads', () => {
    const err = sourceFileError({ type: 'video/mp4', size: MAX_SOURCE_BYTES + 1 })
    expect(err).toMatch(/limit is 2\.00 GB/)
    // The 2.35 GB file from the bug report is over the limit and now rejected,
    // before it can blow up decodeAudioData in the extract step.
    expect(sourceFileError({ type: 'video/mp4', size: 2_346_036_326 })).toMatch(/2\.18 GB/)
  })
})

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response
const fail = (status: number) => ({ ok: false, status }) as Response

const file = new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' })

describe('presignedUpload', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs prepare → PUT → register and returns the stored url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ok({ uploadUrl: 'https://bucket/put', storageKey: 'source/clip.mp4' }),
      )
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({ url: 'https://cdn/source/clip.mp4' }))
    vi.stubGlobal('fetch', fetchMock)

    const url = await presignedUpload(file, '/api/uploads/source', 'proj-1')
    expect(url).toBe('https://cdn/source/clip.mp4')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/uploads/source/prepare')
    // Step 2 PUTs the bytes straight to the presigned bucket URL.
    expect(fetchMock.mock.calls[1][0]).toBe('https://bucket/put')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT' })
    expect(fetchMock.mock.calls[1][1].credentials).toBeUndefined()
    expect(fetchMock.mock.calls[2][0]).toBe('/api/uploads/source/register')
  })

  it('reads url from nested record/data shapes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ uploadUrl: 'https://bucket/put', storageKey: 'k' }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({ record: { url: 'https://cdn/nested' } }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await presignedUpload(file, '/api/uploads/audio', 'proj-1')).toBe('https://cdn/nested')
  })

  it('throws when prepare fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(fail(403)))
    await expect(presignedUpload(file, '/api/uploads/source', 'proj-1')).rejects.toThrow(
      /prepare failed \(403\)/,
    )
  })

  it('throws when prepare omits uploadUrl/storageKey', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({ storageKey: 'k' })))
    await expect(presignedUpload(file, '/api/uploads/source', 'proj-1')).rejects.toThrow(
      /missing uploadUrl\/storageKey/,
    )
  })

  it('throws when the bucket PUT fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ uploadUrl: 'https://bucket/put', storageKey: 'k' }))
      .mockResolvedValueOnce(fail(413))
    vi.stubGlobal('fetch', fetchMock)
    await expect(presignedUpload(file, '/api/uploads/source', 'proj-1')).rejects.toThrow(
      /Bucket upload failed \(413\)/,
    )
  })

  it('throws when register returns no url', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ uploadUrl: 'https://bucket/put', storageKey: 'k' }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({}))
    vi.stubGlobal('fetch', fetchMock)
    await expect(presignedUpload(file, '/api/uploads/source', 'proj-1')).rejects.toThrow(
      /missing url/,
    )
  })
})

describe('toSignedUrl', () => {
  it('reads the flat url', () => {
    expect(toSignedUrl({ url: 'https://storage.googleapis.com/bucket/o?sig=x' })).toBe(
      'https://storage.googleapis.com/bucket/o?sig=x',
    )
  })

  it('reads the nested data.url shape', () => {
    expect(toSignedUrl({ data: { url: 'https://bucket/signed' } })).toBe('https://bucket/signed')
  })

  it('throws on a missing, empty, or non-string url', () => {
    expect(() => toSignedUrl({})).toThrow(/missing url/)
    expect(() => toSignedUrl({ url: '' })).toThrow(/missing url/)
    expect(() => toSignedUrl({ url: 42 })).toThrow(/missing url/)
    expect(() => toSignedUrl(null)).toThrow(/missing url/)
  })
})
