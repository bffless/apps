/**
 * ValueView dispatches one closed vocabulary of types (02) to a viewer; these
 * tests pin the dispatch table plus the two contract details Task 15's
 * consumers depend on: the file card's Download link always ends `download=1`,
 * and a named `render` shows the M2 placeholder badge above the base viewer.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { ValueView } from './ValueView'
import type { FileRef } from '../../lib/runner/types'

// jsdom has no canvas (ChartView.test.tsx explains why); ValueView's own
// dispatch test only needs to know `render: chart` reaches ChartView, not
// that uPlot can actually draw into a headless DOM.
vi.mock('uplot', () => {
  class MockUPlot {
    static paths = { bars: () => undefined }
    destroy() {}
  }
  return { default: MockUPlot }
})

describe('ValueView', () => {
  it('renders null as an em dash', () => {
    render(<ValueView decl={{ type: 'string' }} value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders a file value with a video ref as a <video> plus a Download link ending download=1', () => {
    const ref: FileRef = {
      path: 'workflows/hello/hello/runs/run_1/clip.mp4',
      name: 'clip.mp4',
      contentType: 'video/mp4',
      size: 12345,
      url: '/api/uploads/hello/hello/runs/run_1/clip.mp4',
    }
    const { container } = render(<ValueView decl={{ type: 'file' }} value={ref} />)
    const video = container.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('src')).toBe(ref.url)

    const download = screen.getByText('Download') as HTMLAnchorElement
    expect(download.tagName).toBe('A')
    expect(download.getAttribute('href')).toBe(`${ref.url}?download=1`)
    expect(download.hasAttribute('download')).toBe(true)

    // FileCard always shows name, human size, and contentType regardless of player.
    expect(screen.getByText('clip.mp4')).toBeInTheDocument()
    expect(screen.getByText('video/mp4')).toBeInTheDocument()
  })

  // apps#363: the player is a stricter sink than the Download link — a
  // cross-origin `http(s)` url would leak the member's session cookie to a
  // third party the same way an untrusted fetch would, so it fails
  // `isSameOriginUrl` even though `isSafeUrl` (the Download link's own gate)
  // allows any http(s) scheme.
  it('renders no player for a cross-origin File ref, but still offers Download', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'clip.mp4',
      contentType: 'video/mp4',
      size: 1,
      url: 'https://other.example/clip.mp4',
    }
    const { container } = render(<ValueView decl={{ type: 'file' }} value={ref} />)

    expect(container.querySelector('video')).toBeNull()
    const download = screen.getByText('Download') as HTMLAnchorElement
    expect(download.tagName).toBe('A')
    expect(download.getAttribute('href')).toBe(`${ref.url}?download=1`)
  })

  it('renders the player for a same-origin absolute File ref url', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'clip.mp4',
      contentType: 'video/mp4',
      size: 1,
      url: `${window.location.origin}/api/uploads/clip.mp4`,
    }
    const { container } = render(<ValueView decl={{ type: 'file' }} value={ref} />)

    const video = container.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('src')).toBe(ref.url)
  })

  it('appends download=1 with & when the url already has a query string', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'take.mov',
      contentType: 'video/quicktime',
      size: 1,
      url: '/api/uploads/p?sig=abc',
    }
    render(<ValueView decl={{ type: 'file' }} value={ref} />)
    const download = screen.getByText('Download') as HTMLAnchorElement
    expect(download.getAttribute('href')).toBe('/api/uploads/p?sig=abc&download=1')
  })

  it('renders a table value with column headers from decl.columns', () => {
    render(
      <ValueView
        decl={{ type: 'table', columns: [{ key: 'title' }, { key: 'start', type: 'number' }] }}
        value={[
          { title: 'Intro', start: 0 },
          { title: 'Outro', start: 42 },
        ]}
      />,
    )
    expect(screen.getByRole('columnheader', { name: 'title' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'start' })).toBeInTheDocument()
    expect(screen.getByText('Intro')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('falls back to the keys of the first row when decl.columns is absent', () => {
    render(<ValueView decl={{ type: 'table' }} value={[{ a: 1, b: 2 }]} />)
    expect(screen.getByRole('columnheader', { name: 'a' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'b' })).toBeInTheDocument()
  })

  it('renders a list of strings as one chip per item', () => {
    const { container } = render(
      <ValueView decl={{ type: 'string', list: true }} value={['alpha', 'beta', 'gamma']} />,
    )
    const chips = container.querySelectorAll('.chip')
    expect(chips).toHaveLength(3)
    expect(chips[0].textContent).toBe('alpha')
    expect(chips[1].textContent).toBe('beta')
    expect(chips[2].textContent).toBe('gamma')
  })

  it('shows the number chip as String(value) and the boolean chip as true/false', () => {
    const { container: numberContainer } = render(<ValueView decl={{ type: 'number' }} value={42} />)
    expect(numberContainer.querySelector('.chip')?.textContent).toBe('42')

    const { container: boolContainer } = render(<ValueView decl={{ type: 'boolean' }} value={false} />)
    expect(boolContainer.querySelector('.chip')?.textContent).toBe('false')
  })

  it('shows an "(unknown)" renderer badge above the base viewer for an unrecognized decl.render', () => {
    render(<ValueView decl={{ type: 'json', render: 'bogus' }} value={{ a: 1 }} />)
    expect(screen.getByText('renderer: bogus (unknown)')).toBeInTheDocument()
    expect(screen.queryByTestId('renderer')).not.toBeInTheDocument()
  })

  it('shows no badge at all when decl.render is absent', () => {
    const { container } = render(<ValueView decl={{ type: 'json' }} value={{ a: 1 }} />)
    expect(container.querySelector('.value-renderer-badge')).toBeNull()
  })

  it('renders a render: transcript declaration through TranscriptView, with no badge', () => {
    render(
      <ValueView
        decl={{ type: 'json', render: 'transcript' }}
        value={[{ text: 'hi', start: 0, end: 1 }]}
      />,
    )
    const renderer = screen.getByTestId('renderer')
    expect(renderer).toHaveAttribute('data-render', 'transcript')
    expect(screen.getByRole('button', { name: '[0:00] hi' })).toBeInTheDocument()
    expect(screen.queryByText(/^renderer:/)).not.toBeInTheDocument()
  })

  it('renders a render: images declaration through ImagesView, with no badge', () => {
    const refValue: FileRef = {
      path: 'p',
      name: 'pic.png',
      contentType: 'image/png',
      size: 10,
      url: '/api/uploads/pic.png',
    }
    const { container } = render(<ValueView decl={{ type: 'json', render: 'images' }} value={[refValue]} />)
    const renderer = screen.getByTestId('renderer')
    expect(renderer).toHaveAttribute('data-render', 'images')
    expect(container.querySelector('img')?.getAttribute('src')).toBe(refValue.url)
    expect(screen.queryByText(/^renderer:/)).not.toBeInTheDocument()
  })

  it('lets the payload-unavailable chip win over a named render: transcript/images', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'report.json',
      contentType: 'application/json',
      size: 300,
      url: '/api/uploads/report.json',
    }
    render(<ValueView decl={{ type: 'json', render: 'transcript' }} value={{ $file: ref, $error: '500' }} />)
    expect(screen.getByTestId('payload-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('renderer')).not.toBeInTheDocument()
  })

  // Final review, finding 3: the badge used to say "(unknown)" on a *known*
  // renderer just because its payload was unavailable — worse than useless,
  // since it misnamed a renderer this dispatch understands perfectly well.
  // The chip alone says everything there is to say here.
  it('shows the payload-unavailable chip with no badge at all for a known renderer (transcript)', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'transcript.json',
      contentType: 'application/json',
      size: 300,
      url: '/api/uploads/transcript.json',
    }
    render(<ValueView decl={{ type: 'json', render: 'transcript' }} value={{ $file: ref, $error: '500' }} />)
    expect(screen.getByTestId('payload-unavailable')).toBeInTheDocument()
    expect(screen.queryByText(/^renderer:/)).not.toBeInTheDocument()
  })

  it('keeps the "(unknown)" badge alongside the chip for an unrecognised render name with an unavailable payload', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'report.json',
      contentType: 'application/json',
      size: 300,
      url: '/api/uploads/report.json',
    }
    render(<ValueView decl={{ type: 'json', render: 'bogus' }} value={{ $file: ref, $error: '500' }} />)
    expect(screen.getByTestId('payload-unavailable')).toBeInTheDocument()
    expect(screen.getByText('renderer: bogus (unknown)')).toBeInTheDocument()
  })

  it('renders a render: chart declaration through ChartView, with no badge', () => {
    render(
      <ValueView
        decl={{ type: 'json', render: 'chart', mapping: { x: 'line', y: 'chars' } }}
        value={[
          { line: 'a', chars: 13 },
          { line: 'b', chars: 14 },
        ]}
      />,
    )
    const renderer = screen.getByTestId('renderer')
    expect(renderer).toHaveAttribute('data-render', 'chart')
    expect(screen.queryByText(/^renderer:/)).not.toBeInTheDocument()
  })

  it('renders a render: code declaration through CodeView, with no badge', () => {
    render(
      <ValueView
        decl={{ type: 'string', render: 'code', mapping: { language: 'javascript' } }}
        value="const x = 1"
      />,
    )
    const renderer = screen.getByTestId('renderer')
    expect(renderer).toHaveAttribute('data-render', 'code')
    expect(screen.queryByText(/^renderer:/)).not.toBeInTheDocument()
  })

  it('renders a render: island declaration through the island viewer instead of the badge', () => {
    server.use(
      http.get('/w/hello/islands/v.html', () => HttpResponse.text('<!doctype html><p>viewer</p>')),
    )

    render(
      <ValueView
        decl={{ type: 'json', render: 'island', src: 'islands/v.html' }}
        value={{ a: 1 }}
        impl="hello"
      />,
    )

    const renderer = screen.getByTestId('renderer')
    expect(renderer).toHaveAttribute('data-render', 'island')
    expect(screen.getByTestId('island-frame')).toBeInTheDocument()
    expect(screen.queryByText('renderer: island (M2)')).not.toBeInTheDocument()
  })

  // A live run renders its declared outputs before it has recorded them, so the
  // first value a run-output viewer sees is null. Tool input is sent once per
  // mount, so a changed value has to be a new mount or the viewer shows `null`
  // for the life of the run (found by Task 7's browser walk).
  it('keeps the island viewer mounted when the value it shows changes', () => {
    // apps#370: a changed value is a fresh `tool-input` over the live bridge
    // (`IslandFrame.test.tsx` proves the send); the frame — and with it the
    // fetched HTML, the bridge and the island's own state — is never rebuilt.
    server.use(
      http.get('/w/hello/islands/v.html', () => HttpResponse.text('<!doctype html><p>viewer</p>')),
    )

    const decl = { type: 'json', render: 'island', src: 'islands/v.html' } as const

    const { rerender } = render(<ValueView decl={decl} value={null} impl="hello" />)
    const frame = screen.getByTestId('island-frame')

    rerender(<ValueView decl={decl} value={{ line: 'Hello, world!' }} impl="hello" />)
    expect(screen.getByTestId('island-frame')).toBe(frame)

    rerender(<ValueView decl={decl} value={{ line: 'Hello, world!' }} impl="hello" label="v" />)
    expect(screen.getByTestId('island-frame')).toBe(frame)

    rerender(<ValueView decl={decl} value={{ line: 'Hello, studio!' }} impl="hello" />)
    expect(screen.getByTestId('island-frame')).toBe(frame)
  })

  it('falls back to the M2 badge for render: island when no implementation is known', () => {
    render(<ValueView decl={{ type: 'json', render: 'island', src: 'islands/v.html' }} value={{ a: 1 }} />)
    expect(screen.getByText('renderer: island (M2)')).toBeInTheDocument()
    expect(screen.queryByTestId('island-frame')).not.toBeInTheDocument()
  })

  it('falls back to the M2 badge for render: island with no src', () => {
    render(<ValueView decl={{ type: 'json', render: 'island' }} value={{ a: 1 }} impl="hello" />)
    expect(screen.getByText('renderer: island (M2)')).toBeInTheDocument()
    expect(screen.queryByTestId('island-frame')).not.toBeInTheDocument()
  })

  it('renders a markdown value through renderMarkdown, with no raw <script> reaching the DOM', () => {
    const { container } = render(<ValueView decl={{ type: 'markdown' }} value={'**bold** <script>alert(1)</script>'} />)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).toContain('&lt;script&gt;')
  })

  it('renders an unknown type through the JsonTree fallback', () => {
    const { container } = render(<ValueView decl={{ type: 'nonsense' }} value={{ a: 1 }} />)
    expect(container.querySelector('details')).toBeTruthy()
  })

  it('renders a label caption and an origin chip', () => {
    render(<ValueView decl={{ type: 'string' }} value="hi" label="Greeting" origin="greet/say" />)
    expect(screen.getByText('Greeting')).toBeInTheDocument()
    expect(screen.getByText('from greet/say')).toBeInTheDocument()
  })

  it('renders a bare path string under a file decl without throwing', () => {
    expect(() =>
      render(<ValueView decl={{ type: 'file' }} value="workflows/hello/hello/inputs/u1/cat.png" />),
    ).not.toThrow()
    expect(screen.getByText('workflows/hello/hello/inputs/u1/cat.png')).toBeInTheDocument()
  })

  it('renders a file object with no contentType as a download card, not a crash', () => {
    const ref = { path: 'p', name: 'take.mov', url: '/api/uploads/p' }
    expect(() => render(<ValueView decl={{ type: 'file' }} value={ref} />)).not.toThrow()
    expect(screen.getByText('take.mov')).toBeInTheDocument()
    expect(screen.getByText('unknown type')).toBeInTheDocument()
    const download = screen.getByText('Download') as HTMLAnchorElement
    expect(download.getAttribute('href')).toBe('/api/uploads/p?download=1')
  })

  it('falls through to JsonTree for a file value that is neither a File ref nor a bare string', () => {
    const { container } = render(<ValueView decl={{ type: 'file' }} value={{ nope: true }} />)
    expect(container.querySelector('details')).toBeTruthy()
  })
  it('renders no player, no link and no download for a File ref whose url is not allow-listed', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'evil.png',
      contentType: 'image/png',
      size: 10,
      url: 'javascript:alert(1)',
    }
    const { container } = render(<ValueView decl={{ type: 'file' }} value={ref} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelector('object')).toBeNull()
    // The card still says what it saw, as text.
    expect(screen.getByText('evil.png')).toBeInTheDocument()
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument()
  })

  it('still renders the Download link for a root-relative File ref url', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'poster.png',
      contentType: 'image/png',
      size: 10,
      url: '/api/uploads/hello/hello/runs/run_1/poster.png',
    }
    const { container } = render(<ValueView decl={{ type: 'file' }} value={ref} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ref.url)
    expect((screen.getByText('Download') as HTMLAnchorElement).getAttribute('href')).toBe(
      `${ref.url}?download=1`,
    )
  })

  // Task 13: a payload whose fetch failed on the read path arrives here as the
  // `{ $file, $error }` sentinel `lib/payloadFetch` leaves in place of the
  // value — it must report itself rather than be stringified through whatever
  // viewer the declaration asked for.
  it('renders an unreadable offloaded payload as a chip that names the error and still offers the bytes', () => {
    const ref: FileRef = {
      path: 'workflows/hello/hello/runs/run_1/slow/0/start/report.json',
      name: 'report.json',
      contentType: 'application/json',
      size: 300_000,
      url: '/api/uploads/workflows/hello/hello/runs/run_1/slow/0/start/report.json',
    }

    render(<ValueView decl={{ type: 'markdown' }} value={{ $file: ref, $error: '500' }} />)

    const chip = screen.getByTestId('payload-unavailable')
    expect(chip).toHaveTextContent('payload unavailable — 500')
    expect((within(chip).getByRole('link', { name: 'Download' }) as HTMLAnchorElement).getAttribute('href')).toBe(
      `${ref.url}?download=1`,
    )
  })

  it('refuses to link an unsafe payload url, and says so as text', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'report.json',
      contentType: 'application/json',
      size: 1,
      url: 'javascript:alert(1)',
    }

    render(<ValueView decl={{ type: 'json' }} value={{ $file: ref, $error: 'boom' }} />)

    const chip = screen.getByTestId('payload-unavailable')
    expect(chip).toHaveTextContent('payload unavailable — boom')
    expect(within(chip).queryByRole('link')).toBeNull()
  })

  it('renders a null row in a table as an em dash instead of throwing', () => {
    expect(() =>
      render(
        <ValueView
          decl={{ type: 'table', columns: [{ key: 'title' }] }}
          value={[null, { title: 'Intro' }, 'nope']}
        />,
      ),
    ).not.toThrow()
    expect(screen.getByText('Intro')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('reports hover start/end through onHover, mouse only (08 data-flow highlight)', () => {
    const onHover = vi.fn()
    const { container } = render(
      <ValueView decl={{ type: 'string' }} value="hi" onHover={onHover} />,
    )
    const wrapper = container.querySelector('.value')!

    fireEvent.mouseEnter(wrapper)
    expect(onHover).toHaveBeenLastCalledWith(true)

    fireEvent.mouseLeave(wrapper)
    expect(onHover).toHaveBeenLastCalledWith(false)
  })

  it('never throws hovering a value with no onHover given', () => {
    const { container } = render(<ValueView decl={{ type: 'string' }} value="hi" />)
    const wrapper = container.querySelector('.value')!
    expect(() => {
      fireEvent.mouseEnter(wrapper)
      fireEvent.mouseLeave(wrapper)
    }).not.toThrow()
  })
})
