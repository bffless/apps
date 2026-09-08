import { describe, test, expect } from 'vitest'
import type { ApiLike } from '../src/api.js'
import type { Downloaded } from '../src/download.js'
import { DriverError, EXIT } from '../src/errors.js'
import { contentTypeFor, toFileRef, uploadFileInputs } from '../src/upload.js'

interface Call {
  path: string
  method: string
  body: unknown
}

/**
 * The files trio, faked: `prepare` hands back a key derived from the filename,
 * the PUT records the bytes, `register` answers the ref the harness's own mock
 * answers with (06). Nothing here touches a browser.
 */
function fakeApi(): { api: ApiLike; calls: Call[]; puts: Array<{ url: string; bytes: Uint8Array }> } {
  const calls: Call[] = []
  const puts: Array<{ url: string; bytes: Uint8Array }> = []
  const sizes = new Map<string, number>()
  const api: ApiLike = {
    async json(path, init) {
      calls.push({ path, method: init?.method ?? 'GET', body: init?.body })
      const body = (init?.body ?? {}) as Record<string, unknown>
      if (path.endsWith('/files/prepare')) {
        const key = `workflows/${body.impl}/${body.workflow}/${body.scope}/${body.filename}`
        sizes.set(key, Number(body.size ?? 0))
        return { status: 200, body: { uploadUrl: `https://bucket.test/${key}`, storageKey: key } }
      }
      if (path.endsWith('/files/register')) {
        const key = String(body.storageKey ?? '')
        return {
          status: 200,
          body: {
            path: key,
            name: body.originalName,
            contentType: 'image/png',
            size: sizes.get(key) ?? 0,
            url: `/api/uploads/${key}`,
          },
        }
      }
      throw new Error(`unexpected call ${path}`)
    },
    async text() {
      throw new Error('not used')
    },
    async bytes() {
      throw new Error('not used')
    },
    async put(url, bytes) {
      puts.push({ url, bytes })
      return { status: 200 }
    },
  }
  return { api, calls, puts }
}

const deps = {
  async readFile(path: string) {
    return new TextEncoder().encode(`bytes of ${path}`)
  },
  basename: (path: string) => path.split('/').pop() ?? path,
  contentTypeFor,
}

const ctx = { impl: 'hello', workflow: 'interactive' }

describe('uploadFileInputs', () => {
  test('a `file` input given a local path is uploaded and replaced by the registered File ref', async () => {
    const { api, calls, puts } = fakeApi()
    const values = await uploadFileInputs(
      api,
      ctx,
      { clip: { type: 'file' }, greeting: { type: 'string' } },
      { clip: './clip.png', greeting: 'Hi' },
      deps,
    )

    expect(calls.map((c) => c.path)).toEqual([
      '/api/workflow/files/prepare',
      '/api/workflow/files/register',
    ])
    expect(calls[0]!.body).toEqual({
      impl: 'hello',
      workflow: 'interactive',
      scope: 'inputs',
      filename: 'clip.png',
      contentType: 'image/png',
      size: 'bytes of ./clip.png'.length,
    })
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe('https://bucket.test/workflows/hello/interactive/inputs/clip.png')

    // A whole File ref, not a bare path — `validateValue('file', …)` wants
    // every field (07's page contract).
    expect(values.clip).toEqual({
      path: 'workflows/hello/interactive/inputs/clip.png',
      name: 'clip.png',
      contentType: 'image/png',
      size: 'bytes of ./clip.png'.length,
      url: '/api/uploads/workflows/hello/interactive/inputs/clip.png',
    })
    // Everything else passes through untouched.
    expect(values.greeting).toBe('Hi')
  })

  test('a `list: true` file input maps every entry', async () => {
    const { api, puts } = fakeApi()
    const values = await uploadFileInputs(
      api,
      ctx,
      { shots: { type: 'file', list: true } },
      { shots: ['./a.png', './b.png'] },
      deps,
    )
    expect(puts).toHaveLength(2)
    expect((values.shots as Array<{ name: string }>).map((r) => r.name)).toEqual(['a.png', 'b.png'])
  })

  test('a value that is already a File ref is left alone — no second upload', async () => {
    const { api, calls } = fakeApi()
    const ref = {
      path: 'workflows/x',
      name: 'x.png',
      contentType: 'image/png',
      size: 3,
      url: '/api/uploads/workflows/x',
    }
    const values = await uploadFileInputs(api, ctx, { clip: { type: 'file' } }, { clip: ref }, deps)
    expect(calls).toEqual([])
    expect(values.clip).toBe(ref)
  })

  test('an unsupplied or null file input stays unsupplied — an omitted input takes its default', async () => {
    const { api, calls } = fakeApi()
    const values = await uploadFileInputs(
      api,
      ctx,
      { clip: { type: 'file' }, other: { type: 'file' } },
      { clip: null },
      deps,
    )
    expect(calls).toEqual([])
    expect(values).toEqual({ clip: null })
  })

  test('a `prepare` that answers no upload url fails loudly', async () => {
    const api: ApiLike = {
      async json() {
        return { status: 200, body: {} }
      },
      async text() {
        throw new Error('not used')
      },
      async bytes() {
        throw new Error('not used')
      },
      async put() {
        return { status: 200 }
      },
    }
    await expect(
      uploadFileInputs(api, ctx, { clip: { type: 'file' } }, { clip: './clip.png' }, deps),
    ).rejects.toThrow(/upload url/i)
  })

  test('a non-2xx prepare fails loudly, with a driver-side exit code', async () => {
    const { api } = fakeApi()
    const failing: ApiLike = { ...api, async json() {
      return { status: 403, body: { error: 'nope' } }
    } }
    const error = await uploadFileInputs(
      failing,
      ctx,
      { clip: { type: 'file' } },
      { clip: './clip.png' },
      deps,
    ).catch((e: unknown) => e)
    // Never exit 1: an upload the harness refused is a driver-side failure, not
    // a run that ran and failed (errors.ts's rule).
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toMatch(/403/)
  })

  test('a non-2xx register is a DriverError too', async () => {
    const { api } = fakeApi()
    const failing: ApiLike = { ...api, async json(path, init) {
      if (path.endsWith('/files/register')) return { status: 500, body: {} }
      return api.json(path, init)
    } }
    const error = await uploadFileInputs(
      failing,
      ctx,
      { clip: { type: 'file' } },
      { clip: './clip.png' },
      deps,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toMatch(/register answered 500/)
  })

  test('a PUT that never got a response keeps the harness\'s own CORS diagnosis', async () => {
    // status 0 is "no response at all" — the symptom a live run trips over
    // first when the bucket's CORS allow-list omits the app origin.
    const { api } = fakeApi()
    const blocked: ApiLike = { ...api, async put() {
      return { status: 0, error: 'Failed to fetch' }
    } }
    const error = await uploadFileInputs(
      blocked,
      ctx,
      { clip: { type: 'file' } },
      { clip: './clip.png' },
      deps,
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toContain(
      "the upload PUT failed before a response — usually the storage bucket's CORS allow-list",
    )
    expect((error as Error).message).toContain('Failed to fetch')
  })
})

/** A fake download: no network, one temp-less "file" whose cleanup is observable. */
function fakeDownload(over: Partial<Downloaded> = {}) {
  const calls: Array<{ url: string; input: string }> = []
  let cleaned = 0
  const download = async (url: string, input: string): Promise<Downloaded> => {
    calls.push({ url, input })
    return {
      path: '/tmp/fake/anatomy.mp4',
      name: 'anatomy.mp4',
      contentType: 'video/mp4',
      size: 40_826_579,
      cleanup: async () => { cleaned += 1 },
      ...over,
    }
  }
  return { download, calls, cleaned: () => cleaned }
}

describe('uploadFileInputs — URL values (spec 2026-09-08)', () => {
  const URL_ = 'https://handoff.j5s.dev/api/uploads/content/test-public/anatomy.mp4'

  test('a `file` input given an https:// URL is downloaded, PUT from disk, registered, and replaced by the ref', async () => {
    const { api, calls, puts } = fakeApi()
    const dl = fakeDownload()
    const disk: Array<{ url: string; path: string; size: number; contentType: string }> = []
    const values = await uploadFileInputs(
      api,
      ctx,
      { recording: { type: 'file' }, direction: { type: 'string' } },
      { recording: URL_, direction: 'see https://example.com/notes' },
      {
        ...deps,
        download: dl.download,
        putFromDisk: async (url, path, size, contentType) => { disk.push({ url, path, size, contentType }); return { status: 200 } },
      },
    )
    expect(dl.calls).toEqual([{ url: URL_, input: 'recording' }])
    expect(calls.map((c) => c.path)).toEqual(['/api/workflow/files/prepare', '/api/workflow/files/register'])
    expect(calls[0]!.body).toEqual({
      impl: 'hello', workflow: 'interactive', scope: 'inputs',
      filename: 'anatomy.mp4', contentType: 'video/mp4', size: 40_826_579,
    })
    // The bucket PUT came from disk, never through the page.
    expect(puts).toEqual([])
    expect(disk).toEqual([{ url: 'https://bucket.test/workflows/hello/interactive/inputs/anatomy.mp4', path: '/tmp/fake/anatomy.mp4', size: 40_826_579, contentType: 'video/mp4' }])
    expect(calls[1]!.body).toMatchObject({ storageKey: 'workflows/hello/interactive/inputs/anatomy.mp4', originalName: 'anatomy.mp4' })
    expect(values.recording).toMatchObject({ path: 'workflows/hello/interactive/inputs/anatomy.mp4', name: 'anatomy.mp4' })
    // A URL in a `string` input is text, untouched (D1: the declared type decides).
    expect(values.direction).toBe('see https://example.com/notes')
    expect(dl.cleaned()).toBe(1)
  })

  test('a `list: true` file input mixes URLs and local paths per entry', async () => {
    const { api, puts } = fakeApi()
    const dl = fakeDownload()
    const values = await uploadFileInputs(
      api, ctx,
      { shots: { type: 'file', list: true } },
      { shots: ['./a.png', URL_] },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(puts).toHaveLength(1) // only the local path went through the page
    expect(dl.calls).toHaveLength(1)
    expect((values.shots as Array<{ name: string }>).map((r) => r.name)).toEqual(['a.png', 'anatomy.mp4'])
  })

  test('a failed download surfaces as the DriverError it threw, and nothing is prepared', async () => {
    const { api, calls } = fakeApi()
    const download = async () => { throw new DriverError(`download of recording answered 404 for ${URL_}`, EXIT.USAGE) }
    const error = await uploadFileInputs(api, ctx, { recording: { type: 'file' } }, { recording: URL_ }, { ...deps, download }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as Error).message).toBe(`download of recording answered 404 for ${URL_}`)
    expect(calls).toEqual([])
  })

  test('a from-disk PUT that never got a response is a usage fault naming the URL, and the temp file is cleaned up', async () => {
    const { api } = fakeApi()
    const dl = fakeDownload()
    const error = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: URL_ },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 0, error: 'fetch failed: ECONNRESET' }) },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toBe(`the upload PUT failed before a response (fetch failed: ECONNRESET) while uploading ${URL_}`)
    expect(dl.cleaned()).toBe(1)
  })

  test('a non-2xx from-disk PUT is a usage fault naming the URL', async () => {
    const { api } = fakeApi()
    const dl = fakeDownload()
    const error = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: URL_ },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 403 }) },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as Error).message).toBe(`the upload PUT answered 403 for ${URL_}`)
  })

  test('under --mocks a URL value is refused before any call', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    const error = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: URL_ },
      { ...deps, download: dl.download }, { mocks: true },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toBe(`URL file inputs are not supported under --mocks; pass a local path (input recording: ${URL_})`)
    expect(dl.calls).toEqual([])
    expect(calls).toEqual([])
  })

  test('a local path still goes through the page PUT, exactly as before', async () => {
    const { api, puts } = fakeApi()
    let fromDisk = 0
    await uploadFileInputs(api, ctx, { clip: { type: 'file' } }, { clip: './clip.png' }, {
      ...deps,
      putFromDisk: async () => { fromDisk += 1; return { status: 200 } },
    })
    expect(puts).toHaveLength(1)
    expect(fromDisk).toBe(0)
  })
})

describe('uploadFileInputs — a URL wrapped in an object (Claude Desktop shape)', () => {
  const URL_ = 'https://handoff.j5s.dev/api/uploads/content/test-public/anatomy.mp4'
  const wrapped = (over: Record<string, unknown> = {}) => ({
    contentType: 'video/mp4',
    name: 'anatomy.mp4',
    path: 'test-public/anatomy.mp4',
    url: URL_,
    ...over,
  })

  test('a wrapped URL object is downloaded, PUT from disk, registered, and replaced by the ref', async () => {
    const { api, calls, puts } = fakeApi()
    const dl = fakeDownload()
    const values = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: wrapped() },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(dl.calls).toEqual([{ url: URL_, input: 'recording' }])
    expect(calls[0]!.body).toMatchObject({ filename: 'anatomy.mp4' })
    expect(calls[1]!.body).toMatchObject({ originalName: 'anatomy.mp4' })
    expect(values.recording).toMatchObject({ path: 'workflows/hello/interactive/inputs/anatomy.mp4', name: 'anatomy.mp4' })
    expect(puts).toEqual([])
  })

  test('a wrapped URL object without a name uses the download\'s own name', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    const noName = wrapped()
    delete (noName as { name?: string }).name
    await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: noName },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(calls[0]!.body).toMatchObject({ filename: 'anatomy.mp4' }) // the download's own name (fakeDownload's default)
  })

  test('a wrapped URL object\'s name is sanitised — separators become `_`', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: wrapped({ name: '../evil.mp4' }) },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(calls[0]!.body).toMatchObject({ filename: '.._evil.mp4' })
    expect(calls[1]!.body).toMatchObject({ originalName: '.._evil.mp4' })
  })

  test('a wrapped URL object\'s dot-name falls back to the download\'s own name', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: wrapped({ name: '..' }) },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(calls[0]!.body).toMatchObject({ filename: 'anatomy.mp4' })
  })

  test('a wrapped URL object\'s empty name falls back to the download\'s own name', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: wrapped({ name: '' }) },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(calls[0]!.body).toMatchObject({ filename: 'anatomy.mp4' })
  })

  test('a registered ref is untouched, even if it also carries an https:// url', async () => {
    const { api, calls } = fakeApi()
    const ref = { path: 'workflows/hello/interactive/inputs/clip.png', name: 'clip.png', contentType: 'image/png', size: 3, url: URL_ }
    const values = await uploadFileInputs(api, ctx, { recording: { type: 'file' } }, { recording: ref }, deps)
    expect(calls).toEqual([])
    expect(values.recording).toBe(ref)
  })

  test('an object with neither a `workflows/` path nor an https:// url is untouched', async () => {
    const { api, calls } = fakeApi()
    const value = { path: 'somewhere/else.png', foo: 'bar' }
    const values = await uploadFileInputs(api, ctx, { recording: { type: 'file' } }, { recording: value }, deps)
    expect(calls).toEqual([])
    expect(values.recording).toBe(value)
  })

  test('an http:// url in an object is untouched — https only', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    const value = { url: 'http://handoff.j5s.dev/anatomy.mp4', name: 'anatomy.mp4' }
    const values = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: value },
      { ...deps, download: dl.download },
    )
    expect(calls).toEqual([])
    expect(dl.calls).toEqual([])
    expect(values.recording).toBe(value)
  })

  test('under --mocks a wrapped URL is refused with the same message a string URL gets', async () => {
    const { api, calls } = fakeApi()
    const dl = fakeDownload()
    const error = await uploadFileInputs(
      api, ctx, { recording: { type: 'file' } }, { recording: wrapped() },
      { ...deps, download: dl.download }, { mocks: true },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DriverError)
    expect((error as DriverError).code).toBe(EXIT.USAGE)
    expect((error as Error).message).toBe(`URL file inputs are not supported under --mocks; pass a local path (input recording: ${URL_})`)
    expect(dl.calls).toEqual([])
    expect(calls).toEqual([])
  })

  test('a `list: true` file input mixes a string URL, a wrapped URL and a local path', async () => {
    const { api, puts } = fakeApi()
    const dl = fakeDownload()
    const values = await uploadFileInputs(
      api, ctx, { shots: { type: 'file', list: true } },
      { shots: ['./a.png', URL_, wrapped({ name: 'poster.mp4' })] },
      { ...deps, download: dl.download, putFromDisk: async () => ({ status: 200 }) },
    )
    expect(puts).toHaveLength(1) // only the local path went through the page
    expect(dl.calls).toEqual([
      { url: URL_, input: 'shots' },
      { url: URL_, input: 'shots' },
    ])
    expect((values.shots as Array<{ name: string }>).map((r) => r.name)).toEqual(['a.png', 'anatomy.mp4', 'poster.mp4'])
  })
})

describe('toFileRef', () => {
  test('fills in the fields the register answer may leave out', () => {
    expect(toFileRef({ storagePath: 'workflows/a/b/poster.svg', size: 12 })).toEqual({
      path: 'workflows/a/b/poster.svg',
      name: 'poster.svg',
      contentType: 'application/octet-stream',
      size: 12,
      url: '/api/uploads/workflows/a/b/poster.svg',
    })
  })
})

describe('contentTypeFor', () => {
  test('maps the extensions a driver actually sends, and falls back to octet-stream', () => {
    expect(contentTypeFor('a/b/clip.mp4')).toBe('video/mp4')
    expect(contentTypeFor('poster.svg')).toBe('image/svg+xml')
    expect(contentTypeFor('notes.MD')).toBe('text/markdown')
    expect(contentTypeFor('mystery.qqq')).toBe('application/octet-stream')
  })
})
