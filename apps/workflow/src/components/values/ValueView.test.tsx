/**
 * ValueView dispatches one closed vocabulary of types (02) to a viewer; these
 * tests pin the dispatch table plus the two contract details Task 15's
 * consumers depend on: the file card's Download link always ends `download=1`,
 * and a named `render` shows the M2 placeholder badge above the base viewer.
 */
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { ValueView } from './ValueView'
import type { FileRef } from '../../lib/runner/types'

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
      url: '/api/workflow/files/hello/hello/runs/run_1/clip.mp4',
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

  it('appends download=1 with & when the url already has a query string', () => {
    const ref: FileRef = {
      path: 'p',
      name: 'take.mov',
      contentType: 'video/quicktime',
      size: 1,
      url: '/api/workflow/files/p?sig=abc',
    }
    render(<ValueView decl={{ type: 'file' }} value={ref} />)
    const download = screen.getByText('Download') as HTMLAnchorElement
    expect(download.getAttribute('href')).toBe('/api/workflow/files/p?sig=abc&download=1')
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

  it('shows a renderer badge above the base viewer for a named decl.render', () => {
    render(<ValueView decl={{ type: 'json', render: 'transcript' }} value={[{ text: 'hi', start: 0, end: 1 }]} />)
    expect(screen.getByText('renderer: transcript (M2)')).toBeInTheDocument()
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
  it('re-mounts the island viewer when the value it shows changes', () => {
    server.use(
      http.get('/w/hello/islands/v.html', () => HttpResponse.text('<!doctype html><p>viewer</p>')),
    )

    const decl = { type: 'json', render: 'island', src: 'islands/v.html' } as const

    const { rerender } = render(<ValueView decl={decl} value={null} impl="hello" />)
    const first = screen.getByTestId('island-frame')

    rerender(<ValueView decl={decl} value={{ line: 'Hello, world!' }} impl="hello" />)
    expect(screen.getByTestId('island-frame')).not.toBe(first)

    // A *deep-equal but freshly allocated* value must NOT remount: `RunPage`
    // rebuilds its RunState through `replayRun` on every poll while a run is
    // running, so identity churns even when nothing changed — and a remount
    // would re-fetch the island and rebuild the bridge every poll interval.
    const second = screen.getByTestId('island-frame')
    rerender(<ValueView decl={decl} value={{ line: 'Hello, world!' }} impl="hello" label="v" />)
    expect(screen.getByTestId('island-frame')).toBe(second)

    // …but a genuinely different value still does.
    rerender(<ValueView decl={decl} value={{ line: 'Hello, studio!' }} impl="hello" />)
    expect(screen.getByTestId('island-frame')).not.toBe(second)
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
    const ref = { path: 'p', name: 'take.mov', url: '/api/workflow/files/p' }
    expect(() => render(<ValueView decl={{ type: 'file' }} value={ref} />)).not.toThrow()
    expect(screen.getByText('take.mov')).toBeInTheDocument()
    expect(screen.getByText('unknown type')).toBeInTheDocument()
    const download = screen.getByText('Download') as HTMLAnchorElement
    expect(download.getAttribute('href')).toBe('/api/workflow/files/p?download=1')
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
      url: '/api/workflow/files/hello/hello/runs/run_1/poster.png',
    }
    const { container } = render(<ValueView decl={{ type: 'file' }} value={ref} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(ref.url)
    expect((screen.getByText('Download') as HTMLAnchorElement).getAttribute('href')).toBe(
      `${ref.url}?download=1`,
    )
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
})
