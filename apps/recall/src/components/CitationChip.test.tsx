/**
 * TDD for Task 10: the chat markdown renderer maps YouTube watch links to a
 * clickable citation chip (calls `onSeek` instead of navigating away) and
 * leaves every other link as a plain `target="_blank"` anchor.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CitationChip } from './CitationChip'

describe('CitationChip', () => {
  it('renders a YouTube watch link as a chip and seeks the player on click', () => {
    const onSeek = vi.fn()
    render(
      <CitationChip
        href="https://www.youtube.com/watch?v=abc12345678&t=754s"
        onSeek={onSeek}
      >
        Talk @ 12:34
      </CitationChip>,
    )

    const chip = screen.getByRole('button', { name: 'Talk @ 12:34' })
    expect(chip).toBeInTheDocument()

    fireEvent.click(chip)
    expect(onSeek).toHaveBeenCalledExactlyOnceWith({ youtubeId: 'abc12345678', startSec: 754 })
  })

  it('defaults startSec to 0 when the link has no t= param', () => {
    const onSeek = vi.fn()
    render(
      <CitationChip href="https://www.youtube.com/watch?v=abc12345678" onSeek={onSeek}>
        Talk
      </CitationChip>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Talk' }))
    expect(onSeek).toHaveBeenCalledExactlyOnceWith({ youtubeId: 'abc12345678', startSec: 0 })
  })

  it('renders a non-YouTube link as a plain anchor that opens in a new tab', () => {
    const onSeek = vi.fn()
    render(
      <CitationChip href="https://docs.bffless.app/features/chat/" onSeek={onSeek}>
        Chat docs
      </CitationChip>,
    )

    const link = screen.getByRole('link', { name: 'Chat docs' })
    expect(link).toHaveAttribute('href', 'https://docs.bffless.app/features/chat/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders a plain anchor when href is missing (react-markdown edge case)', () => {
    const onSeek = vi.fn()
    render(<CitationChip onSeek={onSeek}>No href</CitationChip>)
    expect(screen.getByText('No href').tagName).toBe('A')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
