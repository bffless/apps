import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SeekingPlayer } from './SeekingPlayer'

describe('SeekingPlayer', () => {
  it('renders a standard youtube.com embed URL with a rounded start second, autoplay off by default', () => {
    const { container } = render(<SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={754.4} />)
    const iframe = container.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.src).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=754&autoplay=0')
  })

  it('turns autoplay on when explicitly requested (a user-seek mount)', () => {
    const { container } = render(
      <SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={754.4} autoplay />,
    )
    expect(container.querySelector('iframe')?.src).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=754&autoplay=1',
    )
  })

  it('sets an accessible title attribute', () => {
    const { container } = render(
      <SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} title="Intro to Recall" />,
    )
    expect(container.querySelector('iframe')?.title).toBe('Intro to Recall')
  })

  it('falls back to a generic title when none is given', () => {
    const { container } = render(<SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} />)
    expect(container.querySelector('iframe')?.title).toBeTruthy()
  })

  it('remounts the iframe when startSec changes', () => {
    const { container, rerender } = render(
      <SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} autoplay />,
    )
    const first = container.querySelector('iframe')
    expect(first).not.toBeNull()

    rerender(<SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={99} autoplay />)
    const second = container.querySelector('iframe')
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(second?.src).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=99&autoplay=1')
  })

  it('remounts the iframe when youtubeId changes', () => {
    const { container, rerender } = render(
      <SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} />,
    )
    const first = container.querySelector('iframe')

    rerender(<SeekingPlayer youtubeId="otherId1234" startSec={10} />)
    const second = container.querySelector('iframe')
    expect(second).not.toBe(first)
    expect(second?.src).toContain('otherId1234')
  })

  // PR-feedback-6 bugfix: an identical {youtubeId, startSec} seek (e.g. a
  // chat reply citing the same timestamp twice) must still remount — the
  // key can't be derived from youtubeId/startSec alone or a repeat seek is
  // silently a no-op.
  it('remounts the iframe when only nonce changes (same youtubeId + startSec)', () => {
    const { container, rerender } = render(
      <SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} nonce={1} autoplay />,
    )
    const first = container.querySelector('iframe')
    expect(first).not.toBeNull()

    rerender(<SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} nonce={2} autoplay />)
    const second = container.querySelector('iframe')
    expect(second).not.toBeNull()
    expect(second).not.toBe(first) // a genuinely new DOM node, not just a src update
    expect(second?.src).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=10&autoplay=1')
  })

  it('does not remount when neither youtubeId, startSec, nor nonce changes', () => {
    const { container, rerender } = render(
      <SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} nonce={1} />,
    )
    const first = container.querySelector('iframe')

    rerender(<SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} nonce={1} title="unrelated re-render" />)
    const second = container.querySelector('iframe')
    expect(second).toBe(first)
  })

  it('renders inside a 16:9 aspect-ratio container', () => {
    const { container } = render(<SeekingPlayer youtubeId="dQw4w9WgXcQ" startSec={10} />)
    expect(container.querySelector('.aspect-video')).not.toBeNull()
  })
})
