import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TranscriptDiff } from './TranscriptDiff'
import type { ContactSheet } from '../../lib/frames'
import type { FilmFrame } from '../../lib/filmstrip'

/**
 * Original-pane selection semantics for adopt-original (grab → place):
 * - drag (or click) selects; pointer-up grabs the span ("Placing …")
 * - shift-click while grabbed EXTENDS the span to the clicked cell — so a
 *   selection interrupted by scrolling can be continued, not redone
 * - plain click while grabbed starts a fresh selection
 *
 * Grid defaults: 2s rows, 0.1s cells — each word below starts a new row, and a
 * single-cell grab is 0.1s.
 */
const words = [
  { text: 'alpha', start: 0, end: 0.4 },
  { text: 'beta', start: 2.0, end: 2.4 },
  { text: 'gamma', start: 4.0, end: 4.4 },
]

/** The Original pane renders before the New pane, so [0] is the left cell. */
const originalCell = (text: string) => screen.getAllByText(text)[0]

const grab = (text: string) => {
  fireEvent.pointerDown(originalCell(text))
  fireEvent.pointerUp(window)
}

const renderDiff = () => {
  const onAdoptOriginal = vi.fn()
  render(<TranscriptDiff words={words} duration={6} onAdoptOriginal={onAdoptOriginal} />)
  return onAdoptOriginal
}

/** The grabbed duration shown in the sticky "Placing …" banner. */
const placingBanner = () => screen.getByText(/Placing/).textContent

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

describe('TranscriptDiff original-pane selection', () => {
  it('click-release grabs a single cell', () => {
    renderDiff()
    grab('alpha')
    expect(placingBanner()).toContain('0.1s')
  })

  it('shift-click extends the grabbed span to a later cell', () => {
    renderDiff()
    grab('alpha') // {0, 0.1}
    fireEvent.pointerDown(originalCell('beta'), { shiftKey: true }) // → {0, 2.1}
    expect(placingBanner()).toContain('2.1s')
  })

  it('shift-click before the span extends its start backwards', () => {
    renderDiff()
    grab('beta') // {2.0, 2.1}
    fireEvent.pointerDown(originalCell('alpha'), { shiftKey: true }) // → {0, 2.1}
    expect(placingBanner()).toContain('2.1s')
  })

  it('plain click while grabbed starts the selection over', () => {
    renderDiff()
    grab('alpha')
    fireEvent.pointerDown(originalCell('beta'), { shiftKey: true })
    expect(placingBanner()).toContain('2.1s')
    grab('gamma') // restart: a fresh single-cell grab at 4.0
    expect(placingBanner()).toContain('0.1s')
  })

  it('typed snippet: type → place → click the New pane drops it there', () => {
    const onAddSnippet = vi.fn()
    render(<TranscriptDiff words={words} duration={6} onAddSnippet={onAddSnippet} />)
    fireEvent.click(screen.getByRole('button', { name: /add snippet/i }))
    fireEvent.change(screen.getByLabelText('Snippet text'), {
      target: { value: 'a five word snippet here' },
    })
    // 5 words at 2.5 wps ⇒ a 2.0s footprint, shown in the input bar…
    expect(screen.getByText('≈2.0s')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Place' }))
    // …and in the sticky placing banner once confirmed.
    expect(placingBanner()).toContain('2.0s')
    fireEvent.click(screen.getAllByText('beta')[1]) // the New pane is in place mode
    expect(onAddSnippet).toHaveBeenCalledTimes(1)
    const [text, dropStart] = onAddSnippet.mock.calls[0]
    expect(text).toBe('a five word snippet here')
    expect(dropStart).toBe(2.0)
  })

  it('Escape cancels a pending snippet placement', () => {
    const onAddSnippet = vi.fn()
    render(<TranscriptDiff words={words} duration={6} onAddSnippet={onAddSnippet} />)
    fireEvent.click(screen.getByRole('button', { name: /add snippet/i }))
    fireEvent.change(screen.getByLabelText('Snippet text'), { target: { value: 'hello there' } })
    fireEvent.click(screen.getByRole('button', { name: 'Place' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText(/Placing/)).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByText('beta')[1])
    expect(onAddSnippet).not.toHaveBeenCalled()
  })

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
    render(<TranscriptDiff words={words} duration={6} frames={frames} />)
    fireEvent.click(screen.getAllByRole('button', { name: /view frame at 0:00/i })[0])
    expect(screen.getByText('Frame · 0:00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close frame view' }))
    expect(screen.queryByText('Frame · 0:00')).not.toBeInTheDocument()
  })

  it('search: selecting cells in a result set grabs their span, click places it', async () => {
    const onAdoptOriginal = vi.fn()
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
    render(
      <TranscriptDiff words={words} duration={6} onAdoptOriginal={onAdoptOriginal} onSearch={onSearch} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /⌕ search/i }))
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'bike ride' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(onSearch).toHaveBeenCalledWith('bike ride')
    // The set renders the span's words on the SAME selectable grid as the
    // Original pane — grab a cell, shift-click to extend, exactly as there.
    const bike = await screen.findByText('bike')
    expect(screen.getByText('Scene 1')).toBeInTheDocument()
    fireEvent.pointerDown(bike)
    fireEvent.pointerUp(window)
    expect(placingBanner()).toContain('0.1s') // single-cell grab at 2.0
    fireEvent.pointerDown(screen.getByText('ride'), { shiftKey: true }) // extend → {2.0, 2.6}
    expect(placingBanner()).toContain('0.6s')
    fireEvent.click(screen.getAllByText('beta')[1]) // the New pane is in place mode
    expect(onAdoptOriginal).toHaveBeenCalledTimes(1)
    const [origStart, origEnd, dropStart] = onAdoptOriginal.mock.calls[0]
    expect(origStart).toBe(2.0)
    expect(origEnd).toBeCloseTo(2.6)
    expect(dropStart).toBe(2.0)
  })

  it('search: empty results render a no-matches note', async () => {
    const onSearch = vi.fn().mockResolvedValue([])
    render(<TranscriptDiff words={words} duration={6} onSearch={onSearch} />)
    fireEvent.click(screen.getByRole('button', { name: /⌕ search/i }))
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'zzz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(await screen.findByText(/No matches/)).toBeInTheDocument()
  })

  it('search: a set selection cancels a pending snippet (one gesture at a time)', async () => {
    const onSearch = vi.fn().mockResolvedValue([
      { start: 0, end: 2, snippet: 'pedal', reason: '', words: [{ text: 'pedal', start: 0, end: 0.4 }] },
    ])
    render(
      <TranscriptDiff
        words={words}
        duration={6}
        onAdoptOriginal={vi.fn()}
        onAddSnippet={vi.fn()}
        onSearch={onSearch}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /⌕ search/i }))
    fireEvent.change(screen.getByLabelText('Search query'), { target: { value: 'pedal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    const chip = await screen.findByText('pedal')
    fireEvent.click(screen.getByRole('button', { name: /add snippet/i }))
    fireEvent.change(screen.getByLabelText('Snippet text'), { target: { value: 'hello there' } })
    fireEvent.click(screen.getByRole('button', { name: 'Place' }))
    expect(placingBanner()).toContain('snippet')
    fireEvent.pointerDown(chip)
    fireEvent.pointerUp(window)
    expect(placingBanner()).toContain('of original audio')
  })

  it('the extended span is what gets dropped on the New pane', () => {
    const onAdoptOriginal = renderDiff()
    grab('alpha')
    fireEvent.pointerDown(originalCell('beta'), { shiftKey: true }) // grabbed {0, 2.1}
    // The New pane is in place mode now — click its 'gamma' cell to drop at 4.0.
    const newPaneGamma = screen.getAllByText('gamma')[1]
    fireEvent.click(newPaneGamma)
    expect(onAdoptOriginal).toHaveBeenCalledTimes(1)
    const [origStart, origEnd] = onAdoptOriginal.mock.calls[0]
    expect(origStart).toBe(0)
    expect(origEnd).toBeCloseTo(2.1)
  })
})

describe('TranscriptDiff original-audio playback highlight', () => {
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
  /** The grid cell (grandparent div) holding a word in the Original pane. */
  const cellOf = (text: string) => originalCell(text).closest('div')!

  it('highlights the exact cell under the playhead, and moves it as time advances', () => {
    render(<TranscriptDiff words={words} duration={6} originalAudioUrl="blob:original" />)
    const audio = playFromRowZero()
    seek(audio, 0.04) // col 0 of row 0 — the cell holding "alpha"
    expect(cellOf('alpha').className).toContain('ring-terracotta')
    seek(audio, 0.65) // col 6 of row 0 — the highlight leaves alpha's cell
    expect(cellOf('alpha').className).not.toContain('ring-terracotta')
  })

  it('clears the cell highlight when playback pauses', () => {
    render(<TranscriptDiff words={words} duration={6} originalAudioUrl="blob:original" />)
    const audio = playFromRowZero()
    seek(audio, 0.04)
    expect(cellOf('alpha').className).toContain('ring-terracotta')
    fireEvent.pause(audio)
    expect(cellOf('alpha').className).not.toContain('ring-terracotta')
  })
})
