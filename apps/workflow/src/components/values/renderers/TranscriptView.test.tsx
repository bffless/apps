/**
 * `TranscriptView` (Task 15, 02): a segment's clickable stamp, and its
 * `JsonTree` fallback for a value that doesn't match the transcript shape.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MediaSeekProvider, useMediaSeek } from '../MediaSeekContext'
import { TranscriptView } from './TranscriptView'

const SEGMENTS = [
  { text: 'Hello there', start: 0, end: 2 },
  { text: 'General Kenobi', start: 65, end: 68, speaker: 'Obi-Wan' },
  { text: 'You are a bold one', start: 130, end: 133 },
]

describe('TranscriptView', () => {
  it('renders one button per segment, stamped [m:ss], with a speaker prefix when present', () => {
    render(<TranscriptView value={SEGMENTS} />)
    const wrapper = screen.getByTestId('renderer')
    expect(wrapper).toHaveAttribute('data-render', 'transcript')

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]).toHaveTextContent('[0:00] Hello there')
    expect(buttons[1]).toHaveTextContent('[1:05] Obi-Wan: General Kenobi')
    expect(buttons[2]).toHaveTextContent('[2:10] You are a bold one')
  })

  it('seeks the registered element to the segment start on click', () => {
    let registeredEl: HTMLMediaElement | null = null
    function FakePlayer() {
      const { register } = useMediaSeek()
      return (
        <video
          data-testid="fake-player"
          ref={(el) => {
            if (el) {
              registeredEl = el
              register(el)
            }
          }}
        />
      )
    }

    render(
      <MediaSeekProvider>
        <FakePlayer />
        <TranscriptView value={SEGMENTS} />
      </MediaSeekProvider>,
    )

    fireEvent.click(screen.getByText('[1:05] Obi-Wan: General Kenobi'))
    expect(registeredEl).not.toBeNull()
    expect((registeredEl as unknown as HTMLMediaElement).currentTime).toBe(65)
  })

  it.each([
    'not an array',
    [{ start: 0 }],
    [{ text: 'no start' }],
    [{ text: 'bad start', start: 'zero' }],
  ])('falls back to JsonTree for a malformed value %#', (value) => {
    const { container } = render(<TranscriptView value={value} />)
    const wrapper = screen.getByTestId('renderer')
    expect(wrapper).toHaveAttribute('data-render', 'transcript')
    expect(container.querySelector('.json-leaf, .json-node')).toBeTruthy()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
