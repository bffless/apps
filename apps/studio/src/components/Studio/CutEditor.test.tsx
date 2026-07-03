import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CutEditor } from './CutEditor'
import type { ContactSheet } from '../../lib/frames'
import type { FilmFrame } from '../../lib/filmstrip'

/**
 * Grid defaults: 2s rows, 0.1s cells — each word below starts a new row, and a
 * single-cell paint is 0.1s.
 */
const words = [
  { text: 'alpha', start: 0, end: 0.4 },
  { text: 'beta', start: 2.0, end: 2.4 },
  { text: 'gamma', start: 4.0, end: 4.4 },
]

const cellOf = (text: string) => screen.getByText(text).closest('div')!

// jsdom lacks showModal/close — polyfill them as ContactDialog.test.tsx does.
beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '')
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open')
    }
  }
})

describe('CutEditor cut painting', () => {
  it('click-release on kept footage adds a single-cell cut', () => {
    const onEditCut = vi.fn()
    render(<CutEditor words={words} duration={6} onEditCut={onEditCut} />)
    fireEvent.pointerDown(screen.getByText('beta'))
    fireEvent.pointerUp(window)
    expect(onEditCut).toHaveBeenCalledTimes(1)
    const [span, op] = onEditCut.mock.calls[0]
    expect(op).toBe('add')
    expect(span.start).toBe(2.0)
    expect(span.end).toBeCloseTo(2.1)
  })

  it('dragging across cells paints the whole span', () => {
    const onEditCut = vi.fn()
    render(<CutEditor words={words} duration={6} onEditCut={onEditCut} />)
    fireEvent.pointerDown(screen.getByText('alpha'))
    fireEvent.pointerEnter(cellOf('beta'))
    fireEvent.pointerUp(window)
    const [span, op] = onEditCut.mock.calls[0]
    expect(op).toBe('add')
    expect(span.start).toBe(0)
    expect(span.end).toBeCloseTo(2.1)
  })

  it('starting the drag on a red (cut) cell removes instead', () => {
    const onEditCut = vi.fn()
    render(
      <CutEditor
        words={words}
        duration={6}
        cuts={[{ start: 2.0, end: 2.5 }]}
        onEditCut={onEditCut}
      />,
    )
    fireEvent.pointerDown(screen.getByText('beta'))
    fireEvent.pointerUp(window)
    const [, op] = onEditCut.mock.calls[0]
    expect(op).toBe('remove')
  })

  it('paints cut cells red', () => {
    render(<CutEditor words={words} duration={6} cuts={[{ start: 2.0, end: 2.5 }]} />)
    expect(cellOf('beta').className).toContain('bg-terracotta/30')
    expect(cellOf('alpha').className).not.toContain('bg-terracotta/30')
  })

  it('is read-only without onEditCut', () => {
    render(<CutEditor words={words} duration={6} />)
    fireEvent.pointerDown(screen.getByText('beta'))
    fireEvent.pointerUp(window)
    // no crash, no edit callback — nothing to assert beyond render integrity
    expect(screen.getByText('beta')).toBeInTheDocument()
  })
})

describe('CutEditor measured dead space (story 13c)', () => {
  // Row layout at the 2s/0.1s defaults: children[0] is the timestamp gutter,
  // children[1 + col] is the 0.1s cell starting at `rowStart + col * 0.1`.
  const rowOf = (text: string) => cellOf(text).parentElement!
  const cellAt = (row: HTMLElement, col: number) => row.children[1 + col] as HTMLElement

  // alpha spans 0–0.4; measured silence 1.0–2.0; so 0.4–1.0 is noise (sound,
  // no words) on row 0.
  const deadSpace = [{ start: 1.0, end: 2.0 }]

  it('dims wordless cells inside a dead-space span', () => {
    render(<CutEditor words={words} duration={6} deadSpace={deadSpace} />)
    const row = rowOf('alpha')
    expect(cellAt(row, 12).className).toContain('bg-paper-deep/70') // 1.2s — silence
    expect(cellAt(row, 5).className).not.toContain('bg-paper-deep/70') // 0.5s — noise
  })

  it('marks energy-but-no-words cells with a noise dot, but not cells inside a word’s span', () => {
    render(<CutEditor words={words} duration={6} deadSpace={deadSpace} />)
    const row = rowOf('alpha')
    expect(cellAt(row, 5).textContent).toBe('·') // 0.5s — sound, no words
    expect(cellAt(row, 2).textContent).toBe('') // 0.2s — inside alpha's 0–0.4 span
    expect(cellAt(row, 12).textContent).toBe('') // 1.2s — dead space, not noise
  })

  it('paints cuts red on top of dead space', () => {
    render(
      <CutEditor words={words} duration={6} deadSpace={deadSpace} cuts={[{ start: 1.0, end: 1.3 }]} />,
    )
    const row = rowOf('alpha')
    expect(cellAt(row, 11).className).toContain('bg-terracotta/30')
    expect(cellAt(row, 11).className).not.toContain('bg-paper-deep/70')
    expect(cellAt(row, 14).className).toContain('bg-paper-deep/70') // past the cut, still dimmed
  })

  it('without a measurement the grid stays flat — no dimming, no dots', () => {
    render(<CutEditor words={words} duration={6} />)
    const row = rowOf('alpha')
    expect(cellAt(row, 12).className).not.toContain('bg-paper-deep/70')
    expect(cellAt(row, 5).textContent).toBe('')
    expect(screen.getByText(/blank = dead space/)).toBeInTheDocument()
  })

  it('legend switches to the three-state key when measured', () => {
    render(<CutEditor words={words} duration={6} deadSpace={deadSpace} />)
    expect(screen.getByText(/dimmed = dead space/)).toBeInTheDocument()
  })
})

describe('CutEditor filmstrip', () => {
  it('clicking a filmstrip thumbnail opens (and ✕ closes) the full-size view', () => {
    const sheet: ContactSheet = {
      dataUrl: 'data:image/png;base64,x',
      width: 320,
      height: 180,
      cols: 1,
      rows: 1,
      cellWidth: 320,
      cellHeight: 180,
      gap: 0,
      count: 1,
      times: [0],
      interval: 2,
      bytes: 1,
      index: 0,
      total: 1,
    }
    const frames: FilmFrame[] = [{ time: 0, url: sheet.dataUrl, sheet, index: 0 }]
    render(<CutEditor words={words} duration={6} frames={frames} />)
    fireEvent.click(screen.getAllByRole('button', { name: /view frame at 0:00/i })[0])
    expect(screen.getByText('Frame · 0:00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close frame view' }))
    expect(screen.queryByText('Frame · 0:00')).not.toBeInTheDocument()
  })
})

describe('CutEditor search', () => {
  it('renders hits as read-only sets with the scene title', async () => {
    const onSearch = vi.fn().mockResolvedValue([
      {
        start: 2.0,
        end: 4.0,
        snippet: 'bike ride',
        reason: 'literal match',
        sceneTitle: 'Scene 1',
        words: [
          { text: 'bike', start: 2.0, end: 2.4 },
          { text: 'ride', start: 2.5, end: 2.9 },
        ],
      },
    ])
    render(<CutEditor words={words} duration={6} onSearch={onSearch} />)
    fireEvent.click(screen.getByRole('button', { name: /⌕ search/i }))
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'bike ride' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(onSearch).toHaveBeenCalledWith('bike ride')
    expect(await screen.findByText('bike')).toBeInTheDocument()
    expect(screen.getByText('Scene 1')).toBeInTheDocument()
  })

  it('empty results render a no-matches note', async () => {
    const onSearch = vi.fn().mockResolvedValue([])
    render(<CutEditor words={words} duration={6} onSearch={onSearch} />)
    fireEvent.click(screen.getByRole('button', { name: /⌕ search/i }))
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText(/No matches/)).toBeInTheDocument()
  })
})

describe('CutEditor original-audio playback highlight', () => {
  // jsdom doesn't implement media playback — polyfill pause() (the component
  // calls it on mount/scene-switch) to fire the event it would in a browser.
  beforeEach(() => {
    HTMLMediaElement.prototype.pause = function () {
      this.dispatchEvent(new Event('pause'))
    }
  })

  // jsdom never fires loadedmetadata, so playback in these tests is the click
  // (lights the start cell) plus hand-fired timeupdate events with a hand-set
  // currentTime — exactly the inputs the playhead tracking consumes.
  const playFromRowZero = () => {
    const audio = document.querySelector('audio')!
    fireEvent.click(screen.getByRole('button', { name: 'Play original audio from 0:00' }))
    return audio
  }
  const seek = (audio: HTMLAudioElement, time: number) => {
    Object.defineProperty(audio, 'currentTime', { value: time, configurable: true })
    fireEvent.timeUpdate(audio)
  }

  it('highlights the exact cell under the playhead, and moves it as time advances', () => {
    render(<CutEditor words={words} duration={6} originalAudioUrl="blob:original" />)
    const audio = playFromRowZero()
    seek(audio, 0.04) // col 0 of row 0 — the cell holding "alpha"
    expect(cellOf('alpha').className).toContain('ring-terracotta')
    seek(audio, 0.65) // col 6 of row 0 — the highlight leaves alpha's cell
    expect(cellOf('alpha').className).not.toContain('ring-terracotta')
  })

  it('clears the cell highlight when playback pauses', () => {
    render(<CutEditor words={words} duration={6} originalAudioUrl="blob:original" />)
    const audio = playFromRowZero()
    seek(audio, 0.04)
    expect(cellOf('alpha').className).toContain('ring-terracotta')
    fireEvent.pause(audio)
    expect(cellOf('alpha').className).not.toContain('ring-terracotta')
  })
})
