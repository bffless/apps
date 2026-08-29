/**
 * The `review` step's island, against a fake host (`islands/test/fakeIsland.ts`).
 *
 * The step is where a person judges the writer's frames: the post arrives with
 * `frame:<t>` tokens, every token's frame and its nearby candidates are already captured
 * (`by_time`), and this island renders it all on Studio's `MarkdownBody` — front matter
 * as a header, figures with captions, a Change-frame picker over the candidates — and
 * **Looks good** submits the post with its tokens intact (a swapped frame is a retimed
 * token). So the suite is about what gets signed and when, the retime surviving the
 * round trip, and the paths a member never sees: a headless run, a failed
 * `workflow.sign`, a token with no capture. Plus the two things a post can carry that
 * the plain form never showed (apps#441): a GFM table, and a ```mermaid fence — whose
 * library the island fetches from a CDN at runtime, so `./mermaid` is mocked here.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Review } from './App'
import { createFakeHost, toolError, type FakeHost } from '../test/fakeIsland'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, code: string) => {
    if (/BROKEN/.test(code)) throw new Error('Parse error on line 1')
    return { svg: '<svg data-testid="mmd-svg"><text>rendered</text></svg>' }
  }),
  load: vi.fn(async () => ({ initialize: mermaid.initialize, render: mermaid.render })),
}))
vi.mock('./mermaid', () => ({ loadMermaid: mermaid.load }))

const still = (key: string) => `workflows/run/frames/0/still-${key}.jpg`
const signed = (key: string) => `https://bucket.example/${still(key)}?sig=1`

const POST = [
  '---',
  'title: Ship it',
  'description: One sentence about it.',
  '---',
  '',
  '# Ship it',
  '',
  'Intro.',
  '',
  '![The diff](frame:40)',
  '',
  'More prose.',
  '',
  '![The terminal](frame:120)',
  '',
].join('\n')

/** The tokens' frames plus the picker's candidates: 10…70 every 5 s around 40 (its own
 *  second among them), a few around 120, and one far away that no strip may offer. */
const BY_TIME: Record<string, string> = Object.fromEntries(
  [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 100, 110, 120, 130, 300].map((t) => [
    String(t),
    still(String(t)),
  ]),
)

/** The `arguments` of the harness's `ui/notifications/tool-input` for the `review` step. */
function toolInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { post: POST, by_time: BY_TIME, ...over }
}

function renderReview(
  args: Record<string, unknown> = toolInput(),
  host: FakeHost = createFakeHost(),
): FakeHost {
  render(<Review args={args} bridge={host} />)
  return host
}

const figure = (caption: string) => screen.getByRole('img', { name: caption })
const done = () => fireEvent.click(screen.getByTestId('island-done'))
const signedPaths = (host: FakeHost) => host.callsTo('workflow.sign').map((c) => c.arguments.path)

describe('the blog review island', () => {
  it('renders the post with its front matter as a header and its frames inline', async () => {
    const host = renderReview()

    // The front matter is a title/description header, never a `---` heading.
    expect(screen.getByText('One sentence about it.')).toBeInTheDocument()
    expect(screen.queryByText(/^---$/)).toBeNull()
    expect(screen.queryByText(/title: Ship it/)).toBeNull()
    expect(screen.getByText('Intro.')).toBeInTheDocument()

    // Each token is a figure at its signed frame, caption beneath — and only the
    // tokens' own frames are signed up front, not the picker's candidates.
    await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))
    expect(figure('The terminal')).toHaveAttribute('src', signed('120'))
    expect(screen.getByText('The diff')).toBeInTheDocument()
    expect(screen.getByText('The terminal')).toBeInTheDocument()
    expect(signedPaths(host)).toEqual([still('40'), still('120')])
    expect(screen.queryByText(/frame:/)).toBeNull()
    expect(screen.queryByTestId('island-sign-error')).toBeNull()
  })

  it('submits the post unchanged, tokens intact, on Looks good', async () => {
    const host = renderReview()
    await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))
    done()

    await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    expect(host.lastSubmit()).toEqual({ post: POST })
    expect(screen.getByTestId('island-submitted')).toBeInTheDocument()
  })

  describe('Change frame', () => {
    it('offers the captured candidates within ±30 s, signed on demand', async () => {
      const host = renderReview()
      await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))

      fireEvent.click(screen.getAllByRole('button', { name: 'Change frame' })[0])

      // 10…70 at 5 s — thirteen stills including the original — nothing from 120's
      // window, nothing from the far capture at 300 s.
      expect(await screen.findByTitle('Preview frame at 0:45')).toBeInTheDocument()
      expect(screen.getByTitle('Preview frame at 0:40 (original)')).toBeInTheDocument()
      expect(screen.getAllByTitle(/^Preview frame at/)).toHaveLength(13)
      expect(screen.queryByTitle('Preview frame at 1:40')).toBeNull()
      expect(screen.queryByTitle('Preview frame at 5:00')).toBeNull()

      const paths = signedPaths(host)
      expect(paths).toHaveLength(2 + 12)
      expect(paths).toContain(still('10'))
      expect(paths).toContain(still('70'))
      expect(paths).not.toContain(still('100'))
      expect(paths).not.toContain(still('300'))
      // The original was signed once, for the figure — not again for the strip.
      expect(paths.filter((p) => p === still('40'))).toHaveLength(1)
    })

    it('previews a candidate in place, then retimes the token on Use this frame', async () => {
      const host = renderReview()
      await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))

      fireEvent.click(screen.getAllByRole('button', { name: 'Change frame' })[0])
      fireEvent.click(await screen.findByTitle('Preview frame at 0:45'))

      // Scrubbed large, in place of the figure — nothing committed yet.
      await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('45')))
      expect(screen.getByText('Previewing 0:45')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Use this frame' }))

      // The strip closes on the new frame, which is re-framable in turn.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Use this frame' })).toBeNull())
      expect(figure('The diff')).toHaveAttribute('src', signed('45'))
      expect(figure('The terminal')).toHaveAttribute('src', signed('120'))
      expect(screen.getAllByRole('button', { name: 'Change frame' })).toHaveLength(2)

      done()
      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      const post = (host.lastSubmit() as { post: string }).post
      expect(post).toContain('![The diff](frame:45)')
      expect(post).not.toContain('frame:40')
      expect(post).toContain('![The terminal](frame:120)')
      // Only the one token moved: the rest of the post is byte-for-byte the writer's.
      expect(post).toBe(POST.replace('frame:40', 'frame:45'))
    })
  })

  it('edits the markdown directly, and the preview follows', async () => {
    const host = renderReview()
    await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))

    fireEvent.click(screen.getByTestId('island-view-markdown'))
    const editor = screen.getByTestId('island-markdown') as HTMLTextAreaElement
    expect(editor.value).toBe(POST)
    fireEvent.change(editor, { target: { value: POST.replace('Intro.', 'A new intro.') } })

    fireEvent.click(screen.getByTestId('island-view-preview'))
    expect(screen.getByText('A new intro.')).toBeInTheDocument()
    expect(figure('The diff')).toHaveAttribute('src', signed('40'))

    done()
    await waitFor(() => expect(host.lastSubmit()).toBeDefined())
    expect((host.lastSubmit() as { post: string }).post).toContain('A new intro.')
  })

  it('will not send an empty post', async () => {
    renderReview()
    fireEvent.click(screen.getByTestId('island-view-markdown'))
    fireEvent.change(screen.getByTestId('island-markdown'), { target: { value: '  \n' } })
    expect(screen.getByTestId('island-done')).toBeDisabled()
  })

  it('shows a token with no captured frame as a placeholder, and says it will be left out', async () => {
    // A fourth recording's token: `video/frames` seeks three, so nothing was captured
    // for it and `blog-bundle` will drop it. The figure still shows its caption.
    const host = renderReview(toolInput({ post: POST.replace('frame:120', 'frame:999') }))
    await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))

    expect(figure('The terminal').getAttribute('src')).toMatch(/^data:image\/svg\+xml,/)
    expect(screen.getByTestId('island-uncaptured')).toHaveTextContent(
      '1 image has no captured frame (at 999 s) and will be left out of the bundle.',
    )
    // No picker for a frame that does not exist.
    expect(screen.getAllByRole('button', { name: 'Change frame' })).toHaveLength(1)
    expect(signedPaths(host)).toEqual([still('40')])
  })

  it('renders every token as a placeholder when by_time never came', () => {
    renderReview(toolInput({ by_time: [] }))
    expect(figure('The diff').getAttribute('src')).toMatch(/^data:image\/svg\+xml,/)
    expect(screen.getByTestId('island-uncaptured')).toHaveTextContent('2 images have no captured frame')
    expect(screen.queryByRole('button', { name: 'Change frame' })).toBeNull()
  })

  it('shows a refused submit and stays open', async () => {
    const host = createFakeHost()
    host.answer('workflow.submit', () => toolError('{"post":"must be a string"}'))
    renderReview(toolInput(), host)
    done()

    expect(await screen.findByTestId('island-submit-error')).toHaveTextContent('must be a string')
    expect(screen.getByTestId('island-done')).toBeEnabled()
  })

  describe('headless', () => {
    it('submits the writer’s post at once, without signing anything', async () => {
      const host = createFakeHost({ headless: true })
      renderReview(toolInput(), host)

      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      expect(host.lastSubmit()).toEqual({ post: POST })
      expect(host.callsTo('workflow.sign')).toEqual([])
    })

    it('submits exactly once', async () => {
      const host = createFakeHost({ headless: true })
      renderReview(toolInput(), host)

      await waitFor(() => expect(host.callsTo('workflow.submit')).toHaveLength(1))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(host.callsTo('workflow.submit')).toHaveLength(1)
    })
  })

  describe('when signing fails', () => {
    it('says so, keeps the figures as placeholders, and still submits', async () => {
      const host = createFakeHost()
      host.answer('workflow.sign', () => toolError('deployment not found'))
      renderReview(toolInput(), host)

      expect(await screen.findByTestId('island-sign-error')).toHaveTextContent('deployment not found')
      expect(figure('The diff').getAttribute('src')).toMatch(/^data:image\/svg\+xml,/)
      expect(screen.getByText('The diff')).toBeInTheDocument()

      done()
      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      expect(host.lastSubmit()).toEqual({ post: POST })
    })

    it('reports a rejected call (the bridge gone) the same way', async () => {
      const host = createFakeHost()
      host.answer('workflow.sign', () => {
        throw new Error('Not connected')
      })
      renderReview(toolInput(), host)

      expect(await screen.findByTestId('island-sign-error')).toHaveTextContent('Not connected')
    })
  })

  describe('tables and diagrams (apps#441)', () => {
    const TABLE = ['| Field | Type |', '| --- | :-: |', '| `id` | string |', '| note | text |'].join('\n')

    it('renders a GFM table in the post as a <table> inside a scrolling wrapper', async () => {
      const host = renderReview(toolInput({ post: `${POST}\n${TABLE}\n` }))
      const table = screen.getByRole('table')
      expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Field', 'Type'])
      expect(within(table).getAllByRole('row')).toHaveLength(3)
      expect(table.parentElement).toHaveClass('overflow-x-auto')
      expect(screen.queryByText(/\| Field/)).toBeNull()
      // The table survives the round trip as the writer's markdown.
      done()
      await waitFor(() => expect(host.lastSubmit()).toBeDefined())
      expect((host.lastSubmit() as { post: string }).post).toContain('| Field | Type |')
    })

    it('renders a ```mermaid fence as a diagram, loading mermaid once and only when a fence exists', async () => {
      mermaid.load.mockClear()
      renderReview(toolInput({ post: `${POST}\n\x60\x60\x60mermaid\nflowchart LR\n  A --> B\n\x60\x60\x60\n` }))
      expect(await screen.findByTestId('mmd-svg')).toBeInTheDocument()
      expect(screen.getByRole('img', { name: 'Diagram' })).toBeInTheDocument()
      expect(mermaid.load).toHaveBeenCalledTimes(1)
      expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }))
    })

    it('never touches the loader for a post without a fence', async () => {
      mermaid.load.mockClear()
      renderReview()
      await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))
      expect(mermaid.load).not.toHaveBeenCalled()
    })

    it('falls back to the fence’s source with a note when the diagram will not render', async () => {
      renderReview(toolInput({ post: '\x60\x60\x60mermaid\nBROKEN --> ???\n\x60\x60\x60\n' }))
      expect(await screen.findByText(/Diagram could not be rendered/)).toBeInTheDocument()
      expect(document.querySelector('pre code')?.textContent).toBe('BROKEN --> ???')
    })
  })

  it('keeps the original frame in the strip even when its own capture is the only one nearby', async () => {
    const host = renderReview(toolInput({ by_time: { '40': still('40'), '120': still('120') } }))
    await waitFor(() => expect(figure('The diff')).toHaveAttribute('src', signed('40')))

    fireEvent.click(screen.getAllByRole('button', { name: 'Change frame' })[0])
    const strip = await screen.findByTitle('Preview frame at 0:40 (original)')
    expect(within(strip.parentElement as HTMLElement).getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Use this frame' })).toBeDisabled()
    expect(signedPaths(host)).toEqual([still('40'), still('120')])
  })
})
