import { describe, test, expect } from 'vitest'
import type { ApiLike } from '../src/api.js'
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

  test('a non-2xx prepare fails loudly', async () => {
    const { api } = fakeApi()
    const failing: ApiLike = { ...api, async json() {
      return { status: 403, body: { error: 'nope' } }
    } }
    await expect(
      uploadFileInputs(failing, ctx, { clip: { type: 'file' } }, { clip: './clip.png' }, deps),
    ).rejects.toThrow(/403/)
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
