/**
 * The `trim` step's island, against a fake host (`islands/test/fakeIsland.ts`).
 *
 * The step is the one place a person edits the machine's work: the refiner proposes
 * `cuts`, this island renders them on Studio's own `CutEditor` over the scene's clip,
 * and **Done** submits both what was cut and — the part `assemble` actually consumes —
 * the `keep` complement in CLIP time. So the suite is mostly about that arithmetic
 * surviving the round trip, plus the two paths a member never sees: a headless run
 * (submit at once, no eyes to wait for) and a failed `workflow.sign` (say so, render
 * anyway).
 *
 * ## jsdom stubs
 *
 * - **`Image`** — jsdom parses no pixels, so `new Image().onload` never fires and the
 *   sheet geometry (`naturalWidth/Height`) would never resolve. `FakeImage` fires
 *   `onload` on the next microtask with a 960×360 sheet, which is exactly a 3×2 grid
 *   of 320×180 cells for the six capture times below.
 * - **`HTMLMediaElement.prototype.play` / `.pause`** — not implemented in jsdom (it
 *   logs "Not implemented" through the virtual console). `CutEditor` pauses its
 *   `<audio>` on unmount, so every test would otherwise print one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Editor } from './App'
import { createFakeHost, toolError, type FakeHost } from '../test/fakeIsland'

/**
 * A sheet as CE's tiler emits one for `SHEET_TIMES`: a 3×2 grid of 320×180 cells with
 * `padding=2:margin=2`, so 3*320 + 2*2 + 2*2 = 968 wide and 2*180 + 2 + 2*2 = 366 high
 * (R143 — the geometry is unit-tested in `filmstrip.test.ts`).
 */
const SHEET_WIDTH = 968
const SHEET_HEIGHT = 366
const SHEET_TIMES = [0, 5, 10, 15, 20, 25]
/** `CutEditor`'s gutter width, and the scale it crops a 320 px cell to. */
const GUTTER = 150
const SPRITE_SCALE = GUTTER / 320

/** The pixel size `FakeImage` reports for every sheet — a test may lay one out differently. */
let fakeSheetSize = { width: SHEET_WIDTH, height: SHEET_HEIGHT }

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = fakeSheetSize.width
  naturalHeight = fakeSheetSize.height
  set src(_url: string) {
    queueMicrotask(() => this.onload?.())
  }
}

beforeEach(() => {
  fakeSheetSize = { width: SHEET_WIDTH, height: SHEET_HEIGHT }
  vi.stubGlobal('Image', FakeImage)
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn(async () => {}),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  // The player's corner / hidden preference is remembered per browser.
  window.localStorage.clear()
})

/** The scene's transcript words, in ORIGINAL-source seconds (the editor's clock). */
const wordsFrom = (start: number) => [
  { text: 'alpha', start: start + 0, end: start + 0.4 },
  { text: 'beta', start: start + 2, end: start + 2.4 },
  { text: 'gamma', start: start + 10.5, end: start + 11 },
]

/** The `arguments` of the harness's `ui/notifications/tool-input` for the `trim` step. */
function toolInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  const start = 0
  return {
    clip: { path: 'runs/7/clip.mp4', name: 'clip.mp4', contentType: 'video/mp4' },
    // The SOURCE's extracted audio, not the scene clip's (R142): `CutEditor` seeks
    // this element in original-source seconds with no offset, so a scene starting at
    // 100 s would seek 100 s into a 30 s clip WAV and play silence. The workflow feeds
    // it `needs.per-video.outputs.wav[sourceIndex]`.
    wav: { path: 'runs/7/source.wav', name: 'source.wav', contentType: 'audio/wav' },
    scene: { title: 'Scene one', start, end: start + 30, source: 'runs/7/source.mp4' },
    words: wordsFrom(start),
    cuts: [],
    sheets: [{ path: 'runs/7/sheet-0.jpg', contentType: 'image/jpeg' }],
    times: [SHEET_TIMES],
    ...over,
  }
}

/** A scene that starts 100 s into its source — clip time is 100 s behind scene time. */
function laterScene(cuts: { start: number; end: number }[]): Record<string, unknown> {
  return toolInput({
    scene: { title: 'Scene four', start: 100, end: 130, source: 'runs/7/source.mp4' },
    words: wordsFrom(100),
    cuts,
  })
}

function renderEditor(
  args: Record<string, unknown> = toolInput(),
  host: FakeHost = createFakeHost(),
): FakeHost {
  render(<Editor args={args} bridge={host} />)
  return host
}

/** Every sign has answered and the editor is showing the transcript. */
async function settled(): Promise<void> {
  await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument())
}

const done = () => fireEvent.click(screen.getByTestId('island-done'))

/** The first filmstrip cell rendered as a sprite crop of the signed sheet. */
const sheetSprite = () =>
  document.querySelector<HTMLElement>('[style*="https://bucket.example/runs/7/sheet-0.jpg"]')

/**
 * The sprite crop the gutter row starting at `clock` shows. Rows are `CutEditor`'s
 * transcript lines (2 s apart here), each a zoom button around its cropped cell.
 */
const spriteAt = (clock: string) =>
  screen.getByLabelText(`View frame at ${clock} full-size`).firstElementChild as HTMLElement

describe('the cut editor island', () => {
  it('renders the scene on Studio’s editor, with the signed clip and WAV', async () => {
    const host = renderEditor()
    await settled()

    // Every media ref in the step's `with` is exchanged for a presigned URL: the
    // sandboxed frame has no cookie for `/api/uploads/...`.
    await waitFor(() => {
      expect(host.callsTo('workflow.sign').map((c) => c.arguments.path)).toEqual([
        'runs/7/clip.mp4',
        'runs/7/source.wav',
        'runs/7/sheet-0.jpg',
      ])
    })

    const video = await screen.findByTestId('island-clip')
    expect(video).toHaveAttribute('src', 'https://bucket.example/runs/7/clip.mp4?sig=1')

    // `originalAudioUrl` — the editor's transport, so timestamps become play buttons.
    const audio = document.querySelector('audio')
    expect(audio).toHaveAttribute('src', 'https://bucket.example/runs/7/source.wav?sig=1')

    // The filmstrip gutter: the sheet's cells, cropped by `spriteStyle`. The first row
    // starts at 0 s, so it shows cell 0 — drawn at (margin, margin) = (2, 2) and scaled
    // to the 150 px gutter. Asserting the OFFSET, not just the URL: a sheet whose
    // reconstructed geometry is wrong still shows the right image, cropped in the
    // wrong place.
    await waitFor(() => {
      expect(sheetSprite()).not.toBeNull()
    })
    const sprite = sheetSprite()!
    expect(sprite.style.backgroundSize).toBe(
      `${Math.round(SHEET_WIDTH * SPRITE_SCALE)}px ${Math.round(SHEET_HEIGHT * SPRITE_SCALE)}px`,
    )
    expect(sprite.style.backgroundPosition).toBe(
      `-${Math.round(2 * SPRITE_SCALE)}px -${Math.round(2 * SPRITE_SCALE)}px`,
    )

    expect(screen.queryByTestId('island-sign-error')).toBeNull()
  })

  it('submits the whole scene as one kept span when nothing is cut', async () => {
    const host = renderEditor()
    await settled()
    done()

    await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    expect(host.lastSubmit()).toEqual({ cuts: [], keep: [{ start: 0, end: 30 }] })
  })

  it('submits the complement of the refiner’s cuts as `keep`', async () => {
    const host = renderEditor(toolInput({ cuts: [{ start: 10, end: 12 }] }))
    await settled()
    done()

    await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    expect(host.lastSubmit()).toEqual({
      cuts: [{ start: 10, end: 12 }],
      keep: [
        { start: 0, end: 10 },
        { start: 12, end: 30 },
      ],
    })
  })

  it('plays the SOURCE’s audio for a scene that starts mid-source', async () => {
    // R142: the transport seeks `originalAudioUrl` in original-source seconds — this
    // scene's rows are 100–130, so a 30 s clip WAV would seek past its end and play
    // nothing. The workflow hands the island the source's WAV for exactly this reason;
    // the island's job is to sign whatever `wav` it was given and hand it straight to
    // `CutEditor`.
    const host = renderEditor(laterScene([]))
    await settled()

    const audio = document.querySelector('audio')
    expect(audio).toHaveAttribute('src', 'https://bucket.example/runs/7/source.wav?sig=1')
    // The grid is windowed to the scene, so its first row really is at 100 s.
    expect(screen.getByText('1:40')).toBeInTheDocument()
    expect(host.callsTo('workflow.sign').map((c) => c.arguments.path)).toContain(
      'runs/7/source.wav',
    )
  })

  it('shifts `keep` into clip time for a scene that starts mid-source', async () => {
    // `assemble` re-slices the SCENE CLIP, whose timeline starts at 0 — not the
    // source's, where this scene starts at 100 s. `cuts` stay in scene time.
    const host = renderEditor(laterScene([{ start: 110, end: 112 }]))
    await settled()
    done()

    await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    expect(host.lastSubmit()).toEqual({
      cuts: [{ start: 110, end: 112 }],
      keep: [
        { start: 0, end: 10 },
        { start: 12, end: 30 },
      ],
    })
  })

  it('carries a hand-edit on the grid into what it submits', async () => {
    const host = renderEditor()
    await settled()

    // A click-release on a kept cell paints a one-cell (0.1 s) cut at that second.
    fireEvent.pointerDown(screen.getByText('beta'))
    fireEvent.pointerUp(window)
    done()

    await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    type Span = { start: number; end: number }
    const outputs = host.lastSubmit() as { cuts: Span[]; keep: Span[] }
    expect(outputs.cuts).toHaveLength(1)
    expect(outputs.cuts[0].start).toBeCloseTo(2)
    expect(outputs.cuts[0].end).toBeCloseTo(2.1)
    expect(outputs.keep).toHaveLength(2)
    expect(outputs.keep[0]).toEqual({ start: 0, end: 2 })
    expect(outputs.keep[1].start).toBeCloseTo(2.1)
    expect(outputs.keep[1].end).toBe(30)
  })

  it('renders the grid with no filmstrip when this recording has no sheets', async () => {
    // R147: a recording with no spoken audio plans no captures, so the workflow skips its
    // contact-sheet step and this scene's `sheets`/`times` arrive null. The grid is the
    // point of the step and works off `words`/`cuts` — only the gutter is missing.
    const host = renderEditor(toolInput({ sheets: null, times: null }))
    await settled()

    expect(sheetSprite()).toBeNull()
    expect(host.callsTo('workflow.sign').map((c) => c.arguments.path)).toEqual([
      'runs/7/clip.mp4',
      'runs/7/source.wav',
    ])
    done()
    await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    expect(host.lastSubmit()).toEqual({ cuts: [], keep: [{ start: 0, end: 30 }] })
  })

  it('renders the grid with no filmstrip when `times` fell out of step with `sheets`', async () => {
    renderEditor(toolInput({ times: [] }))
    await settled()
    expect(sheetSprite()).toBeNull()
  })

  it('crops the sheet by CE’s reported `cols` rather than inferring 3 across (apps#470)', async () => {
    // The same six captures, but CE laid this sheet out 2 across and 3 down:
    // 2*320 + 2 + 2*2 = 646 wide, 3*180 + 2*2 + 2*2 = 548 high. Cell 2 (the 10 s
    // frame, which the 0:10 row shows) then sits at the start of the SECOND row —
    // (2, 184) — where the old inference would crop (646, 2): the empty third column
    // of the first row.
    fakeSheetSize = { width: 646, height: 548 }
    renderEditor(toolInput({ cols: [2] }))
    await settled()
    await waitFor(() => {
      expect(sheetSprite()).not.toBeNull()
    })

    const sprite = spriteAt('0:10')
    expect(sprite.style.backgroundSize).toBe(
      `${Math.round(646 * SPRITE_SCALE)}px ${Math.round(548 * SPRITE_SCALE)}px`,
    )
    expect(sprite.style.backgroundPosition).toBe(
      `-${Math.round(2 * SPRITE_SCALE)}px -${Math.round(184 * SPRITE_SCALE)}px`,
    )
  })

  it('infers the grid when `cols` is absent — a result from before the field existed', async () => {
    // `toolInput()` passes no `cols`: the 968×366 sheet is read as 3 across, so cell 2
    // is the third column of the first row — (646, 2).
    renderEditor()
    await settled()
    await waitFor(() => {
      expect(sheetSprite()).not.toBeNull()
    })
    expect(spriteAt('0:10').style.backgroundPosition).toBe(
      `-${Math.round(646 * SPRITE_SCALE)}px -${Math.round(2 * SPRITE_SCALE)}px`,
    )
  })

  describe('when every span is cut', () => {
    it('disables Done and says so rather than submitting an empty `keep`', async () => {
      // `assemble` feeds `keep` to `video/slice`, which refuses an empty span list — so
      // there is nothing to submit until a span is released.
      renderEditor(toolInput({ cuts: [{ start: 0, end: 30 }] }))
      await settled()

      expect(screen.getByTestId('island-nothing-kept')).toHaveTextContent(
        'Everything in this scene is cut',
      )
      expect(screen.getByTestId('island-done')).toBeDisabled()
    })

    it('comes back the moment a span is released', async () => {
      const host = renderEditor(toolInput({ cuts: [{ start: 0, end: 30 }] }))
      await settled()

      // A drag on a cut cell releases that second back into the keep.
      fireEvent.pointerDown(screen.getByText('beta'))
      fireEvent.pointerUp(window)

      await waitFor(() => expect(screen.getByTestId('island-done')).toBeEnabled())
      expect(screen.queryByTestId('island-nothing-kept')).toBeNull()
      done()
      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    })
  })

  it('shows a refused submit and stays open', async () => {
    const host = createFakeHost()
    host.answer('workflow.submit', () => toolError('{"keep":"must not be empty"}'))
    renderEditor(toolInput(), host)
    await settled()
    done()

    expect(await screen.findByTestId('island-submit-error')).toHaveTextContent('must not be empty')
    expect(screen.getByTestId('island-done')).toBeEnabled()
  })

  describe('the floating player (apps#432)', () => {
    it('floats the clip over the grid, bottom-right by default, with the grid at full width', async () => {
      renderEditor()
      await settled()

      const player = await screen.findByTestId('island-player')
      expect(player).toHaveAttribute('data-corner', 'bottom-right')
      expect(player).not.toHaveAttribute('data-hidden')
      // Floating from 720 px up; the same box docks full-width below that.
      expect(player.className).toContain('min-[720px]:fixed')
      expect(player.className).toContain('min-[720px]:w-[360px]')
      expect(player.className).toContain('min-[720px]:bottom-4')
      expect(player.className).toContain('w-full')
      expect(within(player).getByTestId('island-clip')).toHaveAttribute(
        'src',
        'https://bucket.example/runs/7/clip.mp4?sig=1',
      )
      // The grid itself is not narrowed to make room: nothing wraps it in a column.
      expect(screen.getByText('alpha').closest('[data-testid="island-player"]')).toBeNull()
    })

    it('moves between the two corners', async () => {
      renderEditor()
      await settled()

      const player = await screen.findByTestId('island-player')
      fireEvent.click(screen.getByTestId('island-player-corner'))
      expect(player).toHaveAttribute('data-corner', 'top-right')
      expect(player.className).toContain('min-[720px]:top-16')
      expect(player.className).not.toContain('min-[720px]:bottom-4')

      fireEvent.click(screen.getByTestId('island-player-corner'))
      expect(player).toHaveAttribute('data-corner', 'bottom-right')
    })

    it('hides without unmounting the element, so the editor keeps driving it', async () => {
      renderEditor()
      await settled()

      const video = await screen.findByTestId('island-clip')
      fireEvent.click(screen.getByTestId('island-player-hide'))

      const player = screen.getByTestId('island-player')
      expect(player).toHaveAttribute('data-hidden', 'true')
      expect(player.className).toMatch(/(^|\s)hidden(\s|$)/)
      // The same `<video>`: `CutEditor`'s `video.ref` still points at it (row
      // click → seek), it is only not shown.
      expect(screen.getByTestId('island-clip')).toBe(video)

      fireEvent.click(screen.getByTestId('island-player-show'))
      expect(screen.getByTestId('island-player')).not.toHaveAttribute('data-hidden')
      expect(screen.queryByTestId('island-player-show')).toBeNull()
    })

    it('remembers the corner and the hidden state per browser', async () => {
      const first = render(<Editor args={toolInput()} bridge={createFakeHost()} />)
      await settled()
      fireEvent.click(screen.getByTestId('island-player-corner'))
      fireEvent.click(screen.getByTestId('island-player-hide'))
      first.unmount()

      renderEditor()
      await settled()
      const player = await screen.findByTestId('island-player')
      expect(player).toHaveAttribute('data-corner', 'top-right')
      expect(player).toHaveAttribute('data-hidden', 'true')
    })

    it('shows no player at all when the clip did not sign', async () => {
      const host = createFakeHost()
      host.answer('workflow.sign', () => toolError('deployment not found'))
      renderEditor(toolInput(), host)
      await settled()

      expect(screen.queryByTestId('island-player')).toBeNull()
      expect(screen.queryByTestId('island-player-show')).toBeNull()
    })
  })

  describe('headless', () => {
    it('submits the refiner’s cuts at once, without waiting to sign anything', async () => {
      const host = createFakeHost({ headless: true })
      renderEditor(toolInput({ cuts: [{ start: 10, end: 12 }] }), host)

      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      expect(host.lastSubmit()).toEqual({
        cuts: [{ start: 10, end: 12 }],
        keep: [
          { start: 0, end: 10 },
          { start: 12, end: 30 },
        ],
      })
      // Nothing to look at, so nothing to sign — and a signing failure must never
      // be what stops an unattended run.
      expect(host.callsTo('workflow.sign')).toEqual([])
    })

    it('keeps the whole scene when the refiner cut all of it, rather than hanging', async () => {
      // Interactively this disables **Done** and waits for a person; unattended there is
      // nobody to wait for, and an empty `keep` would be refused by `video/slice`.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const host = createFakeHost({ headless: true })
      renderEditor(toolInput({ cuts: [{ start: 0, end: 30 }] }), host)

      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      expect(host.lastSubmit()).toEqual({ cuts: [], keep: [{ start: 0, end: 30 }] })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cut the whole scene'))
      warn.mockRestore()
    })

    it('submits exactly once', async () => {
      const host = createFakeHost({ headless: true })
      renderEditor(toolInput(), host)

      await waitFor(() => expect(host.callsTo('workflow.submit')).toHaveLength(1))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(host.callsTo('workflow.submit')).toHaveLength(1)
    })
  })

  describe('Accept — the flag arriving after mount (apps#432)', () => {
    it('submits the cuts as they stand when host-context-changed flips bffless.headless', async () => {
      const host = renderEditor(toolInput({ cuts: [{ start: 10, end: 12 }] }))
      await settled()
      expect(host.lastSubmit()).toBeUndefined()

      // The person painted one more cut before pressing Accept in the harness.
      fireEvent.pointerDown(screen.getByText('beta'))
      fireEvent.pointerUp(window)

      host.setHostContext({ bffless: { headless: true } })

      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      type Span = { start: number; end: number }
      const outputs = host.lastSubmit() as { cuts: Span[]; keep: Span[] }
      expect(outputs.cuts).toHaveLength(2)
      expect(outputs.cuts[0].start).toBeCloseTo(2)
      expect(outputs.cuts[1]).toEqual({ start: 10, end: 12 })
      expect(screen.getByTestId('island-submitted')).toBeInTheDocument()
    })

    it('submits exactly once, and ignores an unrelated context change', async () => {
      const host = renderEditor()
      await settled()

      host.setHostContext({ theme: 'dark' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(host.callsTo('workflow.submit')).toEqual([])

      host.setHostContext({ bffless: { headless: true } })
      await waitFor(() => expect(host.callsTo('workflow.submit')).toHaveLength(1))
      host.setHostContext({ bffless: { headless: true } })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(host.callsTo('workflow.submit')).toHaveLength(1)
    })

    it('keeps the whole scene if everything is cut when Accept arrives, rather than hanging', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const host = renderEditor(toolInput({ cuts: [{ start: 0, end: 30 }] }))
      await settled()
      expect(screen.getByTestId('island-done')).toBeDisabled()

      host.setHostContext({ bffless: { headless: true } })

      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      expect(host.lastSubmit()).toEqual({ cuts: [], keep: [{ start: 0, end: 30 }] })
      warn.mockRestore()
    })
  })

  describe('when signing fails', () => {
    it('says so and still renders the editor', async () => {
      const host = createFakeHost()
      host.answer('workflow.sign', () => toolError('deployment not found'))
      renderEditor(toolInput(), host)

      expect(await screen.findByTestId('island-sign-error')).toHaveTextContent(
        'deployment not found',
      )
      // The grid is the point of the step — it works off `words` and `cuts`, which
      // arrived with the tool input. Only the media is missing.
      await settled()
      expect(screen.queryByTestId('island-clip')).toBeNull()
      done()
      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    })

    it('reports a rejected call (the bridge gone) the same way', async () => {
      const host = createFakeHost()
      host.answer('workflow.sign', () => {
        throw new Error('Not connected')
      })
      renderEditor(toolInput(), host)

      expect(await screen.findByTestId('island-sign-error')).toHaveTextContent('Not connected')
    })
  })
})
