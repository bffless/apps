/**
 * `useSigned`, against the fake host (`islands/test/fakeIsland.ts`), on its own rather
 * than through an island: what is under test is the hook's contract — each path lands
 * as its own `workflow.sign` answers (apps#471), a failure marks only its path, and a
 * re-delivered path list reads as "nothing signed yet" until ITS answers arrive — and
 * `cut-editor`'s suite already covers what the island does with the result.
 */
import { describe, expect, it } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSigned, type ToolResult } from './useSigned'
import { createFakeHost, toolError } from '../test/fakeIsland'

const CLIP = 'runs/7/clip.mp4'
const WAV = 'runs/7/source.wav'
const SHEET = 'runs/7/sheet-0.jpg'

const urlFor = (path: string) => `https://bucket.example/${path}?sig=1`
const signed = (path: string): ToolResult => ({ structuredContent: { url: urlFor(path) } })

/** A `workflow.sign` answer the test releases by hand. */
function deferred(): { result: Promise<ToolResult>; resolve: (result: ToolResult) => void } {
  let resolve!: (result: ToolResult) => void
  const result = new Promise<ToolResult>((r) => {
    resolve = r
  })
  return { result, resolve }
}

describe('useSigned', () => {
  it('answers each path as it signs — the clip does not wait for the last sheet', async () => {
    const host = createFakeHost()
    const sheet = deferred()
    host.answer('workflow.sign', (call) =>
      call.arguments.path === SHEET ? sheet.result : signed(String(call.arguments.path)),
    )

    const { result } = renderHook(() => useSigned(host, [CLIP, WAV, SHEET]))

    // Every path is asked for at once, in order …
    await waitFor(() => expect(host.callsTo('workflow.sign')).toHaveLength(3))
    expect(host.callsTo('workflow.sign').map((c) => c.arguments.path)).toEqual([CLIP, WAV, SHEET])

    // … and the two that answered are usable while the sheet is still signing.
    await waitFor(() => expect(result.current.urls).toEqual({ [CLIP]: urlFor(CLIP), [WAV]: urlFor(WAV) }))
    expect(result.current.error).toBeNull()

    sheet.resolve(signed(SHEET))
    await waitFor(() => expect(result.current.urls[SHEET]).toBe(urlFor(SHEET)))
    expect(result.current.urls).toEqual({
      [CLIP]: urlFor(CLIP),
      [WAV]: urlFor(WAV),
      [SHEET]: urlFor(SHEET),
    })
    expect(result.current.error).toBeNull()
  })

  it('marks only the path that failed, and keeps the rest', async () => {
    const host = createFakeHost()
    host.answer('workflow.sign', (call) =>
      call.arguments.path === WAV ? toolError('deployment not found') : signed(String(call.arguments.path)),
    )

    const { result } = renderHook(() => useSigned(host, [CLIP, WAV, SHEET]))

    await waitFor(() => expect(result.current.error).toBe('deployment not found'))
    await waitFor(() => expect(result.current.urls).toEqual({ [CLIP]: urlFor(CLIP), [SHEET]: urlFor(SHEET) }))
    expect(result.current.urls[WAV]).toBeUndefined()
  })

  it('reports the first failure to arrive, not the first in the list', async () => {
    const host = createFakeHost()
    const clip = deferred()
    host.answer('workflow.sign', (call) => {
      if (call.arguments.path === CLIP) return clip.result
      return toolError(`no such file: ${String(call.arguments.path)}`)
    })

    const { result } = renderHook(() => useSigned(host, [CLIP, WAV]))
    await waitFor(() => expect(result.current.error).toBe(`no such file: ${WAV}`))

    clip.resolve(toolError(`no such file: ${CLIP}`))
    // Still the WAV's: one failure is shown, and the rest are the same story.
    await waitFor(() => expect(host.callsTo('workflow.sign')).toHaveLength(2))
    expect(result.current.error).toBe(`no such file: ${WAV}`)
  })

  it('reads a re-delivered path list as nothing signed yet, and drops the old delivery’s late answer', async () => {
    const host = createFakeHost()
    const late = deferred()
    host.answer('workflow.sign', (call) =>
      call.arguments.path === SHEET ? late.result : signed(String(call.arguments.path)),
    )

    const { result, rerender } = renderHook(({ paths }) => useSigned(host, paths), {
      initialProps: { paths: [CLIP, SHEET] },
    })
    await waitFor(() => expect(result.current.urls).toEqual({ [CLIP]: urlFor(CLIP) }))

    // A new tool input naming different files: the last delivery's URLs must not be
    // shown against this one's, even for the instant before its own answers land.
    rerender({ paths: [WAV] })
    expect(result.current.urls).toEqual({})
    expect(result.current.error).toBeNull()

    await waitFor(() => expect(result.current.urls).toEqual({ [WAV]: urlFor(WAV) }))

    // The superseded delivery's sheet answers now — and is ignored.
    late.resolve(signed(SHEET))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.urls).toEqual({ [WAV]: urlFor(WAV) })
  })

  it('signs nothing when disabled (headless), and reports nothing', async () => {
    const host = createFakeHost({ headless: true })
    const { result } = renderHook(() => useSigned(host, [CLIP, SHEET], false))

    await new Promise((r) => setTimeout(r, 0))
    expect(host.callsTo('workflow.sign')).toEqual([])
    expect(result.current).toEqual({ urls: {}, error: null })
  })
})
