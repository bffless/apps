import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SegmentVoiceControl, type SegmentControl } from './SegmentVoiceControl'

// Mic + clip-player hooks are browser-bound; the chip logic doesn't need them.
vi.mock('./useRecorder', () => ({
  useRecorder: () => ({
    status: 'idle',
    blob: null,
    elapsed: 0,
    url: null,
    stream: null,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  }),
}))
vi.mock('./clipPlayer', () => ({ useClipPlaying: () => false }))

function seg(partial: Partial<SegmentControl> = {}): SegmentControl {
  return {
    sceneId: 'scene-1',
    index: 0,
    start: 0,
    end: 10,
    text: 'a run of narration',
    busy: false,
    ...partial,
  }
}

const noop = () => {}

describe('SegmentVoiceControl — Use original (story 03j)', () => {
  it('offers Use original on an unvoiced AI-suggested-original run', () => {
    const onUseOriginal = vi.fn()
    render(
      <SegmentVoiceControl
        segment={seg({ suggestedSource: 'original' })}
        canAI
        onGenerateAI={noop}
        onRecord={noop}
        onPlay={noop}
        onDelete={noop}
        onUseOriginal={onUseOriginal}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /use original/i }))
    expect(onUseOriginal).toHaveBeenCalledTimes(1)
  })

  it('hides it once the run is voiced', () => {
    render(
      <SegmentVoiceControl
        segment={seg({
          suggestedSource: 'original',
          audioUrl: '/x.wav',
          audioSeconds: 5,
          audioSource: 'original',
        })}
        canAI
        onGenerateAI={noop}
        onRecord={noop}
        onPlay={noop}
        onDelete={noop}
        onUseOriginal={noop}
      />,
    )
    expect(screen.queryByRole('button', { name: /use original/i })).toBeNull()
  })

  it('hides it for revoice / untagged runs', () => {
    const { unmount } = render(
      <SegmentVoiceControl
        segment={seg({ suggestedSource: 'revoice' })}
        canAI
        onGenerateAI={noop}
        onRecord={noop}
        onPlay={noop}
        onDelete={noop}
        onUseOriginal={noop}
      />,
    )
    expect(screen.queryByRole('button', { name: /use original/i })).toBeNull()
    unmount()
    // untagged (no suggestedSource) — the common case for un-refined scenes
    render(
      <SegmentVoiceControl
        segment={seg()}
        canAI
        onGenerateAI={noop}
        onRecord={noop}
        onPlay={noop}
        onDelete={noop}
        onUseOriginal={noop}
      />,
    )
    expect(screen.queryByRole('button', { name: /use original/i })).toBeNull()
  })
})
