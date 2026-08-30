/**
 * ValueView dispatches one closed vocabulary of types (02) to a viewer; these
 * tests pin the dispatch table plus the two contract details Task 15's
 * consumers depend on: the file card's Download link always ends `download=1`,
 * and a named `render` shows the M2 placeholder badge above the base viewer.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { ValueView } from './ValueView'
import { resetShowRaw, setShowRaw } from './rawPreference'
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

  // apps#440: `.chip` is a pill (`border-radius: 999px`); a 2 KB prompt in a
  // pill wraps to twenty lines and the radius turns into an ellipse. The
  // chip/block rule (02): `format: textarea`, a newline, or > 120 characters
  // makes a string a `.value-text` block; a short scalar stays a chip.
  describe('chip or block (02)', () => {
    it('renders a short string as a chip', () => {
      const { container } = render(<ValueView decl={{ type: 'string' }} value="ten chars." />)
      expect(container.querySelector('.chip')?.textContent).toBe('ten chars.')
      expect(container.querySelector('.value-text')).toBeNull()
    })

    it('renders a format: textarea string as a block, however short', () => {
      const { container } = render(
        <ValueView decl={{ type: 'string', format: 'textarea' }} value="short" />,
      )
      expect(container.querySelector('.value-text')?.textContent).toBe('short')
      expect(container.querySelector('.chip')).toBeNull()
    })

    it('renders a multi-line string as a block, with the newlines kept', () => {
      const { container } = render(
        <ValueView decl={{ type: 'string' }} value={'line one\nline two'} />,
      )
      expect(container.querySelector('.value-text')?.textContent).toBe('line one\nline two')
      expect(container.querySelector('.chip')).toBeNull()
    })

    it('renders a string longer than 120 characters as a block, and one of exactly 120 as a chip', () => {
      const atLimit = 'x'.repeat(120)
      const { container: chip } = render(<ValueView decl={{ type: 'string' }} value={atLimit} />)
      expect(chip.querySelector('.chip')?.textContent).toBe(atLimit)

      const past = 'x'.repeat(121)
      const { container: block } = render(<ValueView decl={{ type: 'string' }} value={past} />)
      expect(block.querySelector('.value-text')?.textContent).toBe(past)
      expect(block.querySelector('.chip')).toBeNull()
    })

    it('applies the rule per item in a list, so long items are blocks beside short chips', () => {
      const long = 'a prompt '.repeat(20).trim()
      const { container } = render(
        <ValueView decl={{ type: 'string', list: true }} value={['tag', long, 'two\nlines']} />,
      )
      const items = container.querySelectorAll('.value-list-item')
      expect(items).toHaveLength(3)
      expect(items[0].querySelector('.chip')?.textContent).toBe('tag')
      expect(items[1].querySelector('.value-text')?.textContent).toBe(long)
      expect(items[2].querySelector('.value-text')?.textContent).toBe('two\nlines')
    })

    it('keeps number and boolean values as chips', () => {
      const { container: numberContainer } = render(<ValueView decl={{ type: 'number' }} value={1e21} />)
      expect(numberContainer.querySelector('.chip')).toBeTruthy()
      const { container: boolContainer } = render(<ValueView decl={{ type: 'boolean' }} value={true} />)
      expect(boolContainer.querySelector('.chip')?.textContent).toBe('true')
      expect(boolContainer.querySelector('.value-text')).toBeNull()
    })

    it('renders a long payload-unavailable error as a block that still offers Download', () => {
      const ref: FileRef = {
        path: 'p',
        name: 'report.json',
        contentType: 'application/json',
        size: 1,
        url: '/api/uploads/report.json',
      }
      const error = 'upstream said: ' + 'the bucket is unreachable, '.repeat(6)
      render(<ValueView decl={{ type: 'json' }} value={{ $file: ref, $error: error }} />)
      const note = screen.getByTestId('payload-unavailable')
      expect(note.classList.contains('value-text')).toBe(true)
      expect(note.classList.contains('value-unavailable')).toBe(true)
      expect(note.classList.contains('chip')).toBe(false)
      expect(within(note).getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(
        `${ref.url}?download=1`,
      )
    })
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
    expect(screen.queryByText(/^renderer: island/)).not.toBeInTheDocument()
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

  // The badge says why the island did not draw, not which milestone owes it
  // one: it read "(M2)" long after the named renderers landed (apps#382).
  it('says which half is missing when render: island has a src but no implementation', () => {
    render(<ValueView decl={{ type: 'json', render: 'island', src: 'islands/v.html' }} value={{ a: 1 }} />)
    expect(screen.getByText('renderer: island (no implementation)')).toBeInTheDocument()
    expect(screen.queryByTestId('island-frame')).not.toBeInTheDocument()
  })

  it('says which half is missing when render: island has no src', () => {
    render(<ValueView decl={{ type: 'json', render: 'island' }} value={{ a: 1 }} impl="hello" />)
    expect(screen.getByText('renderer: island (no src)')).toBeInTheDocument()
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
    // A bare path under `type: file` is the file it names: a row with the
    // name, a type guessed from the extension, and a Download (no size).
    expect(screen.getByText('cat.png')).toBeInTheDocument()
    expect(screen.getByText('image/png')).toBeInTheDocument()
    expect((screen.getByText('Download') as HTMLAnchorElement).getAttribute('href')).toContain(
      'workflows/hello/hello/inputs/u1/cat.png',
    )
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

// apps#450: a `json` value is read for its *shape* before the tree — the
// harness's own File refs, homogeneous rows, numbers, storage paths — and an
// author can declare one with `format:`. Every shape flips to the tree via
// the value's `json` button; a value with no shape is the tree, exactly as
// before, with no button at all.
describe('inferred shapes and declared formats (02, apps#450)', () => {
  const clip = (n: number): FileRef => ({
    path: `workflows/studio/long-to-short/runs/run_1/per-scene/${n}/assemble/clip.mp4`,
    name: `clip-${n}.mp4`,
    contentType: 'video/mp4',
    size: 100,
    url: `/api/uploads/workflows/studio/long-to-short/runs/run_1/per-scene/${n}/assemble/clip.mp4`,
  })

  afterEach(() => {
    resetShowRaw()
  })

  it('draws an array of {start, end} rows as a two-column table with seconds, and flips to the tree', () => {
    const cuts = [
      { start: 8.52, end: 10.48 },
      { start: 125.34, end: 130 },
    ]
    const { container } = render(<ValueView decl={{ type: 'json' }} value={cuts} label="cuts" />)
    expect(screen.getByRole('columnheader', { name: 'start' })).toHaveAttribute('data-num')
    expect(screen.getByRole('columnheader', { name: 'end' })).toBeInTheDocument()
    const cells = [...container.querySelectorAll('tbody td')]
    expect(cells.map((td) => td.textContent)).toEqual(['0:08.5', '0:10.5', '2:05.3', '2:10.0'])
    expect(cells[0]).toHaveAttribute('title', '8.52')
    expect(cells[0]).toHaveAttribute('data-num')
    expect(container.querySelector('details')).toBeNull()

    fireEvent.click(screen.getByTestId('value-raw'))
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('details summary')?.textContent).toBe('[2]')
    expect(screen.getByTestId('value-raw')).toHaveTextContent('rendered')
  })

  it('draws an array of floats as a compact list with the count, and show all unfolds it', () => {
    const times = Array.from({ length: 120 }, (_, i) => i * 1.6816666)
    render(<ValueView decl={{ type: 'json' }} value={times} label="times" />)
    const list = screen.getByTestId('inline-list')
    expect(list.textContent).toContain('0, 1.68, 3.36, 5.04')
    expect(list.textContent).toContain('18.5 …')
    expect(list.textContent).toContain('(120)')
    expect(list.textContent).not.toContain('200.12')

    fireEvent.click(screen.getByRole('button', { name: 'show all 120 items' }))
    expect(list.textContent).toContain('200.12')
    expect(screen.getByRole('button', { name: 'show fewer' })).toBeInTheDocument()
  })

  it('draws File refs inside a json object as file cards under their key, and the raw flip removes them', () => {
    const outputs = { clips: [clip(0), clip(1), clip(2), clip(3)], count: 4 }
    const { container } = render(<ValueView decl={{ type: 'json' }} value={outputs} label="per-scene" />)
    const node = screen.getByTestId('json-shaped')
    expect(node).toHaveAttribute('data-shape', 'files')
    expect(node.querySelector('.json-key')?.textContent).toBe('clips: ')
    expect(container.querySelectorAll('.file-card')).toHaveLength(4)
    expect(screen.getAllByRole('link', { name: 'Download' })).toHaveLength(4)
    // `count` is still a leaf of the tree around it.
    expect(container.querySelector('.json-leaf')?.textContent).toBe('count: 4')

    fireEvent.click(screen.getByTestId('value-raw'))
    expect(container.querySelector('.file-card')).toBeNull()
    expect(container.querySelectorAll('details').length).toBeGreaterThan(4)
  })

  it('draws a long storage path as its basename with the whole path on hover and a Copy', async () => {
    const path = 'workflows/studio/long-to-short/runs/run_01M17/per-video/0/upload/take-2.mov'
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      render(<ValueView decl={{ type: 'string' }} value={path} label="source" />)
      const chip = screen.getByTestId('value-path')
      expect(chip).toHaveAttribute('title', path)
      expect(chip.querySelector('.value-path-name')?.textContent).toBe('take-2.mov')
      fireEvent.click(screen.getByRole('button', { name: `Copy ${path}` }))
      expect(writeText).toHaveBeenCalledWith(path)
      expect(await screen.findByText('copied')).toBeInTheDocument()
      // Raw shows the string the row holds.
      fireEvent.click(screen.getByTestId('value-raw'))
      expect(screen.queryByTestId('value-path')).toBeNull()
      expect(screen.getByText(JSON.stringify(path))).toBeInTheDocument()
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    }
  })

  it('leaves a short string, and a string with spaces, as a chip with no flip', () => {
    const { container } = render(<ValueView decl={{ type: 'string' }} value="video/frames" label="path" />)
    expect(container.querySelector('.chip')?.textContent).toBe('video/frames')
    expect(screen.queryByTestId('value-raw')).toBeNull()
  })

  it('format: path makes any string a path chip', () => {
    render(<ValueView decl={{ type: 'string', format: 'path' }} value="out/x.mp4" label="out" />)
    expect(screen.getByTestId('value-path').querySelector('.value-path-name')?.textContent).toBe('x.mp4')
  })

  it('format: seconds spells a number as m:ss.s, with the exact value on hover', () => {
    const { container } = render(<ValueView decl={{ type: 'number', format: 'seconds' }} value={125.34} label="at" />)
    expect(container.querySelector('.chip')?.textContent).toBe('2:05.3')
    expect(container.querySelector('.chip')).toHaveAttribute('title', '125.34')
    fireEvent.click(screen.getByTestId('value-raw'))
    expect(container.querySelector('.json-value')?.textContent).toBe('125.34')
  })

  it('format: seconds on a json list of numbers, and a number list, formats every item', () => {
    render(<ValueView decl={{ type: 'json', format: 'seconds' }} value={[8.52, 125.34]} />)
    expect(screen.getByTestId('inline-list').textContent).toContain('0:08.5, 2:05.3')
  })

  it('draws a number list (type: number, list: true) as a compact list rather than chips', () => {
    const { container } = render(<ValueView decl={{ type: 'number', list: true }} value={[1, 2.5, 3]} />)
    expect(screen.getByTestId('inline-list').textContent).toContain('1, 2.5, 3')
    expect(container.querySelector('.chip')).toBeNull()
  })

  it('format: table draws ragged rows with the declared columns, else the union of keys', () => {
    const rows = [{ a: 1, b: 'x' }, { b: 'y', c: true }]
    const { unmount } = render(
      <ValueView decl={{ type: 'json', format: 'table', columns: [{ key: 'b', label: 'B' }, 'a'] }} value={rows} />,
    )
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['B', 'a'])
    unmount()
    render(<ValueView decl={{ type: 'json', format: 'table' }} value={rows} />)
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['a', 'b', 'c'])
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('format: list draws mixed scalars inline', () => {
    render(<ValueView decl={{ type: 'json', format: 'list' }} value={[1, 'a', true, null]} />)
    expect(screen.getByTestId('inline-list').textContent).toContain('1, a, true, —')
  })

  it('folds a table past 40 rows and a list past 24 items behind show all', () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ i, name: `row ${i}` }))
    const { container, unmount } = render(<ValueView decl={{ type: 'json' }} value={rows} />)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(40)
    fireEvent.click(screen.getByRole('button', { name: 'show all 45 rows' }))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(45)
    unmount()

    const tags = Array.from({ length: 30 }, (_, i) => `tag-${i}`)
    const { container: list } = render(<ValueView decl={{ type: 'string', list: true }} value={tags} />)
    expect(list.querySelectorAll('.value-list-item')).toHaveLength(24)
    fireEvent.click(screen.getByRole('button', { name: 'show all 30 items' }))
    expect(list.querySelectorAll('.value-list-item')).toHaveLength(30)
  })

  it('renders a json value with no shape exactly as before: the tree, and no flip', () => {
    const { container } = render(<ValueView decl={{ type: 'json' }} value={{ a: 1, b: 'two', c: [1, 'x'] }} label="v" />)
    expect(container.querySelector('details')).toBeTruthy()
    expect(container.querySelector('[data-testid="json-shaped"]')).toBeNull()
    expect(screen.queryByTestId('value-raw')).toBeNull()
  })

  it("the pane's Show raw makes every value the tree, and a value's own flip overrides it", () => {
    setShowRaw(true)
    const { container: chip } = render(<ValueView decl={{ type: 'string' }} value="hi" label="s" />)
    expect(chip.querySelector('.json-value')?.textContent).toBe('"hi"')
    expect(chip.querySelector('.chip')).toBeNull()

    const { container: table } = render(<ValueView decl={{ type: 'json' }} value={[{ start: 1, end: 2 }]} label="t" />)
    expect(table.querySelector('table')).toBeNull()
    const flip = within(table).getByTestId('value-raw')
    expect(flip).toHaveTextContent('rendered')
    fireEvent.click(flip)
    expect(table.querySelector('table')).toBeTruthy()
    expect(flip).toHaveTextContent('json')
  })
})
