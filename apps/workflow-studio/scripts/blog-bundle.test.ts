/**
 * `blog-bundle` — the `bundle` step of the `blog` job: `with: { markdown, title, frames, byTime }`
 * in, `{ zip, post }` out. It re-homes the post's `frame:<t>` tokens onto the frames
 * `video/frames` captured and packs `post.md` + `images/` into one portable archive
 * (Studio's "download the bundle" button, issue #71).
 */
import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import blogBundle from './blog-bundle'
import { fakeCtx } from './lib/fakeCtx'
import type { FileRef, ScriptContext } from '@bffless/workflow-script'

type Out = { zip: File; post: string }

const ref = (path: string): FileRef => ({
  path, name: path.split('/').pop() ?? 'file', contentType: 'image/jpeg', size: 3, url: `/api/uploads/${path}`,
})

const F1 = ref('workflows/run/frames/0/still-001.jpg')
const F2 = ref('workflows/run/frames/0/still-002.jpg')

// Inferred as `Uint8Array<ArrayBuffer>` on purpose: `BodyInit` only accepts a view
// over a real `ArrayBuffer`, not the wider `ArrayBufferLike` an annotation would give.
const BYTES = {
  [F1.path]: new Uint8Array([1, 2, 3]),
  [F2.path]: new Uint8Array([4, 5, 6, 7]),
}

const serve: ScriptContext['files']['fetch'] = async (r) => {
  const body = BYTES[r.path]
  if (!body) return new Response(null, { status: 404 })
  return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } })
}

const markdown = [
  '---', 'title: Ship it', '---', '',
  '# Ship it', '',
  '![the diff](frame:10)', '',
  'Prose in between.', '',
  '![the terminal](frame:70)', '',
].join('\n')

describe('blog-bundle', () => {
  it('packs post.md plus one image per frame, bytes intact', async () => {
    const { ctx } = fakeCtx(
      { markdown, title: 'Ship It!', frames: [F1, F2], byTime: { '10': F1.path, '70': F2.path } },
      serve,
    )
    const out = (await blogBundle(ctx)) as Out

    expect(out.zip).toBeInstanceOf(File)
    expect(out.zip.name).toBe('ship-it.zip')
    expect(out.zip.type).toBe('application/zip')

    const entries = unzipSync(new Uint8Array(await out.zip.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual([
      'images/frame-01.jpg', 'images/frame-02.jpg', 'post.md',
    ])
    expect(entries['images/frame-01.jpg']).toEqual(BYTES[F1.path])
    expect(entries['images/frame-02.jpg']).toEqual(BYTES[F2.path])

    const post = strFromU8(entries['post.md'])
    expect(post).toContain('![the diff](images/frame-01.jpg)')
    expect(post).toContain('![the terminal](images/frame-02.jpg)')
    expect(post).toContain('title: Ship it')
    expect(post).not.toContain('frame:')
    expect(out.post).toBe(post)
  })

  it('warns and drops a frame whose bytes will not come back, keeping the rest', async () => {
    const missing = ref('workflows/run/frames/0/gone.jpg')
    const { ctx, annotations } = fakeCtx(
      { markdown, title: 'Ship It!', frames: [F1, missing], byTime: { '10': F1.path, '70': missing.path } },
      serve,
    )
    const out = (await blogBundle(ctx)) as Out

    const entries = unzipSync(new Uint8Array(await out.zip.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(['images/frame-01.jpg', 'post.md'])
    expect(out.post).toContain('![the diff](images/frame-01.jpg)')
    expect(out.post).not.toContain('the terminal')
    expect(annotations).toEqual([
      { level: 'warning', message: expect.stringContaining('gone.jpg') },
    ])
  })

  it('drops a token that never became a frame, leaving no broken image behind', async () => {
    const { ctx, annotations } = fakeCtx(
      { markdown, title: 'x', frames: [F1], byTime: { '10': F1.path } },
      serve,
    )
    const out = (await blogBundle(ctx)) as Out
    expect(out.post).toContain('![the diff](images/frame-01.jpg)')
    expect(out.post).not.toContain('frame:70')
    expect(out.post).not.toContain('the terminal')
    // Silently shipping a post with an image missing is the bad outcome — say so.
    expect(annotations).toEqual([
      { level: 'warning', message: expect.stringContaining('no frame was captured at 70s') },
    ])
  })

  it('bundles a post with no images at all', async () => {
    const { ctx } = fakeCtx({ markdown: '# Prose only', title: 'Prose Only', frames: [], byTime: {} }, serve)
    const out = (await blogBundle(ctx)) as Out
    const entries = unzipSync(new Uint8Array(await out.zip.arrayBuffer()))
    expect(Object.keys(entries)).toEqual(['post.md'])
    expect(out.zip.name).toBe('prose-only.zip')
  })

  it('falls back to `post.zip` when the title has nothing sluggable in it', async () => {
    const { ctx } = fakeCtx({ markdown: '# hi', title: '!!!', frames: [], byTime: {} }, serve)
    expect(((await blogBundle(ctx)) as Out).zip.name).toBe('post.zip')
  })

  it('fetches one frame once, even when the post shows the same moment twice', async () => {
    const seen: string[] = []
    const { ctx } = fakeCtx(
      {
        markdown: '![a](frame:10)\n\n![b](frame:10)',
        title: 'Twice', frames: [F1], byTime: { '10': F1.path },
      },
      async (r) => { seen.push(r.path); return serve(r) },
    )
    const out = (await blogBundle(ctx)) as Out
    expect(seen).toEqual([F1.path])
    const entries = unzipSync(new Uint8Array(await out.zip.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(['images/frame-01.jpg', 'post.md'])
  })

  it('leaves an image it cannot fetch linked to where it lives, and says so', async () => {
    // `planBlogBundle` re-homes EVERY `![alt](url)`, not just this step's frames — an
    // image the creator pasted into the `edit` form included. A Worker cannot fetch an
    // arbitrary URL, so that one must keep its original link rather than point at an
    // `images/frame-NN.jpg` the archive does not hold.
    const pasted = 'https://example.com/logo.png'
    const md = [
      '![the diff](frame:10)', '',
      `![our logo](${pasted})`, '',
      '![the terminal](frame:70)',
    ].join('\n')
    const { ctx, annotations } = fakeCtx(
      { markdown: md, title: 'Mixed', frames: [F1, F2], byTime: { '10': F1.path, '70': F2.path } },
      serve,
    )
    const out = (await blogBundle(ctx)) as Out

    const entries = unzipSync(new Uint8Array(await out.zip.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual([
      'images/frame-01.jpg', 'images/frame-03.jpg', 'post.md',
    ])
    expect(out.post).toContain('![the diff](images/frame-01.jpg)')
    expect(out.post).toContain(`![our logo](${pasted})`)
    expect(out.post).toContain('![the terminal](images/frame-03.jpg)')
    expect(out.post).not.toContain('images/frame-02.jpg')
    expect(strFromU8(entries['post.md'])).toBe(out.post)
    expect(annotations).toEqual([
      { level: 'warning', message: expect.stringContaining(pasted) },
    ])
  })

  it('keys frames by the token global second, not the local second CE seeked', async () => {
    // R140. The post's `frame:70` sits in the SECOND recording — `frame-times` sent it
    // as `{ time: 10, key: '70' }` (local seek, global key) and the `video/frames` rule
    // keyed `byTime` by the key. This step only ever knows the global clock, so a map
    // keyed any other way would silently lose every image past the first recording.
    const second = ref('workflows/run/frames/1/still-001.jpg')
    const bytes = new Uint8Array([9, 9])
    const { ctx, annotations } = fakeCtx(
      { markdown, title: 'Two Takes', frames: [F1, second], byTime: { '10': F1.path, '70': second.path } },
      async (r) => (r.path === second.path
        ? new Response(bytes, { status: 200 })
        : serve(r)),
    )
    const out = (await blogBundle(ctx)) as Out

    const entries = unzipSync(new Uint8Array(await out.zip.arrayBuffer()))
    expect(entries['images/frame-02.jpg']).toEqual(bytes)
    expect(out.post).toContain('![the terminal](images/frame-02.jpg)')
    expect(annotations).toEqual([])
  })

  it('throws a clear error when `byTime` is not a map', async () => {
    const { ctx } = fakeCtx({ markdown, title: 'x', frames: [], byTime: [] }, serve)
    await expect(blogBundle(ctx)).rejects.toThrow(/blog-bundle.*byTime/i)
  })
})
