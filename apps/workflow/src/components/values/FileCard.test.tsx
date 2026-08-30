/**
 * `FileCard` (02) as the step and run Input panes draw it — the player by
 * `contentType`, with the duration a `video/*`/`audio/*` player reports
 * joining name/size/type in the meta row (apps#451). jsdom plays nothing, so
 * these pin the DOM: which element, which attributes, and that nothing
 * autoplays. The url gates (same-origin player, allow-listed Download) are
 * covered from `ValueView.test.tsx`, which dispatches into this card.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FileRef } from '../../lib/runner/types'
import { FileCard } from './FileCard'
import { formatDuration } from './media'

const BASE: FileRef = {
  path: 'workflows/hello/hello/inputs/1/take-1.mp4',
  name: 'take-1.mp4',
  contentType: 'video/mp4',
  size: 3328599040,
  url: '/api/uploads/workflows/hello/hello/inputs/1/take-1.mp4',
}

function loadMetadata(el: Element, duration: number) {
  Object.defineProperty(el, 'duration', { configurable: true, value: duration })
  fireEvent(el, new Event('loadedmetadata'))
}

describe('FileCard — media preview (apps#451)', () => {
  it('draws a video/* ref as a scrubbable player that reads only its metadata and never autoplays', () => {
    const { container } = render(<FileCard refValue={BASE} />)

    const video = screen.getByTestId('file-media')
    expect(video.tagName).toBe('VIDEO')
    expect(video).toHaveAttribute('src', BASE.url)
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(video).not.toHaveAttribute('autoplay')
    // The card's player is never collapsed: the pane shows one input at a time.
    expect(screen.queryByRole('button', { name: /^Play / })).not.toBeInTheDocument()
    expect(container.querySelector('.file-card-meta')).toHaveTextContent('take-1.mp4')
    expect(screen.getByText('3.1 GB')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `${BASE.url}?download=1`)
  })

  it('shows the duration in the meta row once the metadata loads', () => {
    const { container } = render(<FileCard refValue={BASE} />)
    expect(screen.queryByTestId('file-duration')).not.toBeInTheDocument()

    loadMetadata(screen.getByTestId('file-media'), 750)

    const duration = screen.getByTestId('file-duration')
    expect(duration).toHaveTextContent('12:30')
    expect(container.querySelector('.file-card-meta')).toContainElement(duration)
  })

  it('shows no duration when the metadata reports a non-finite one', () => {
    render(<FileCard refValue={BASE} />)

    loadMetadata(screen.getByTestId('file-media'), Number.POSITIVE_INFINITY)

    expect(screen.queryByTestId('file-duration')).not.toBeInTheDocument()
  })

  it('draws an audio/* ref as an <audio> player with the same attributes', () => {
    render(<FileCard refValue={{ ...BASE, name: 'memo.m4a', contentType: 'audio/mp4' }} />)

    const audio = screen.getByTestId('file-media')
    expect(audio.tagName).toBe('AUDIO')
    expect(audio).toHaveAttribute('src', BASE.url)
    expect(audio).toHaveAttribute('controls')
    expect(audio).toHaveAttribute('preload', 'metadata')
    expect(audio).not.toHaveAttribute('autoplay')
  })

  it('keeps drawing an image/* ref as an image, with no player and no duration', () => {
    const { container } = render(<FileCard refValue={{ ...BASE, name: 'me.jpg', contentType: 'image/jpeg' }} />)

    expect(container.querySelector('img')).toHaveAttribute('src', BASE.url)
    expect(screen.queryByTestId('file-media')).not.toBeInTheDocument()
    expect(screen.queryByTestId('file-duration')).not.toBeInTheDocument()
  })

  it('draws any other type as the plain card: meta and Download, no player', () => {
    const { container } = render(<FileCard refValue={{ ...BASE, name: 'take-1.zip', contentType: 'application/zip' }} />)

    expect(container.querySelector('video, audio, img, object')).toBeNull()
    expect(screen.queryByTestId('file-media')).not.toBeInTheDocument()
    expect(screen.getByText('take-1.zip')).toBeInTheDocument()
    expect(screen.getByText('application/zip')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument()
  })
})

describe('formatDuration', () => {
  it('prints m:ss under an hour and h:mm:ss over it, rounding to the second', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5.4)).toBe('0:05')
    expect(formatDuration(83.6)).toBe('1:24')
    expect(formatDuration(750)).toBe('12:30')
    expect(formatDuration(3725)).toBe('1:02:05')
  })

  it('has nothing to say for a non-finite or negative duration', () => {
    expect(formatDuration(Number.NaN)).toBeUndefined()
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(formatDuration(-1)).toBeUndefined()
    expect(formatDuration(undefined)).toBeUndefined()
  })
})
