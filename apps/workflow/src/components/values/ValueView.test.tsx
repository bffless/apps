/**
 * ValueView dispatches one closed vocabulary of types (02) to a viewer; these
 * tests pin the dispatch table plus the two contract details Task 15's
 * consumers depend on: the file card's Download link always ends `download=1`,
 * and a named `render` shows the M2 placeholder badge above the base viewer.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
