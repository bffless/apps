/**
 * TDD for TranscriptView (Task 11), written first against a component that
 * doesn't exist yet. Words are grouped into ~sentence spans: a span ends
 * when a word's text ends with `.`/`?`/`!`, OR when the gap to the next
 * word's start exceeds 1.5s (a pause implies a sentence boundary even
 * without punctuation, e.g. ASR output that drops terminal punctuation).
 * Each span is a single clickable element; clicking it calls
 * `onSeek(span.start)`. The span containing `activeSec` (start <= activeSec
 * < end, where end is the span's last word's end) gets a highlight class.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TranscriptView, type TranscriptWord } from './TranscriptView'

function words(spec: [string, number, number][]): TranscriptWord[] {
  return spec.map(([text, start, end]) => ({ text, start, end }))
}

describe('TranscriptView', () => {
  it('groups words into one span per sentence, split on terminal punctuation', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['world.', 0.4, 0.9],
      ['How', 1.0, 1.2],
      ['are', 1.2, 1.4],
      ['you?', 1.4, 1.8],
    ])
    render(<TranscriptView words={w} onSeek={vi.fn()} />)
    const spans = screen.getAllByTestId('transcript-span')
    expect(spans).toHaveLength(2)
    expect(spans[0]).toHaveTextContent('Hello world.')
    expect(spans[1]).toHaveTextContent('How are you?')
  })

  it('splits a span when the gap to the next word exceeds 1.5s, even without punctuation', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['there', 0.4, 0.9],
      // gap from 0.9 -> 3.0 is 2.1s > 1.5s threshold
      ['Later', 3.0, 3.4],
      ['on', 3.4, 3.6],
    ])
    render(<TranscriptView words={w} onSeek={vi.fn()} />)
    const spans = screen.getAllByTestId('transcript-span')
    expect(spans).toHaveLength(2)
    expect(spans[0]).toHaveTextContent('Hello there')
    expect(spans[1]).toHaveTextContent('Later on')
  })

  it('does not split when the gap is 1.5s or less', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['there', 1.9, 2.3], // gap = 1.5s exactly, not > 1.5
    ])
    render(<TranscriptView words={w} onSeek={vi.fn()} />)
    const spans = screen.getAllByTestId('transcript-span')
    expect(spans).toHaveLength(1)
    expect(spans[0]).toHaveTextContent('Hello there')
  })

  it('closes a trailing span even without terminal punctuation or a following gap', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['world', 0.4, 0.9], // no punctuation, no next word
    ])
    render(<TranscriptView words={w} onSeek={vi.fn()} />)
    expect(screen.getAllByTestId('transcript-span')).toHaveLength(1)
  })

  it('calls onSeek with the clicked span start second', () => {
    const onSeek = vi.fn()
    const w = words([
      ['Hello', 0, 0.4],
      ['world.', 0.4, 0.9],
      ['Second', 5, 5.4],
      ['span.', 5.4, 5.9],
    ])
    render(<TranscriptView words={w} onSeek={onSeek} />)
    const spans = screen.getAllByTestId('transcript-span')
    fireEvent.click(spans[1])
    expect(onSeek).toHaveBeenCalledWith(5)
  })

  it('highlights the span containing activeSec', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['world.', 0.4, 0.9],
      ['Second', 5, 5.4],
      ['span.', 5.4, 5.9],
    ])
    render(<TranscriptView words={w} onSeek={vi.fn()} activeSec={5.2} />)
    const spans = screen.getAllByTestId('transcript-span')
    expect(spans[0]).toHaveAttribute('data-active', 'false')
    expect(spans[1]).toHaveAttribute('data-active', 'true')
  })

  it('treats the active range as [start, end) — the boundary end second belongs to the next span', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['world.', 0.4, 0.9],
      ['Second', 0.9, 1.3],
      ['span.', 1.3, 1.8],
    ])
    render(<TranscriptView words={w} onSeek={vi.fn()} activeSec={0.9} />)
    const spans = screen.getAllByTestId('transcript-span')
    expect(spans[0]).toHaveAttribute('data-active', 'false')
    expect(spans[1]).toHaveAttribute('data-active', 'true')
  })

  it('no span is active when activeSec is undefined', () => {
    const w = words([
      ['Hello', 0, 0.4],
      ['world.', 0.4, 0.9],
    ])
    render(<TranscriptView words={w} onSeek={vi.fn()} />)
    for (const span of screen.getAllByTestId('transcript-span')) {
      expect(span).toHaveAttribute('data-active', 'false')
    }
  })

  it('renders nothing for an empty words array', () => {
    render(<TranscriptView words={[]} onSeek={vi.fn()} />)
    expect(screen.queryAllByTestId('transcript-span')).toHaveLength(0)
  })
})
