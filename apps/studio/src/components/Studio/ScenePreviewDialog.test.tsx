import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Scene } from '../../lib/scenes'
import type { ContactSheet } from '../../lib/frames'
import { ScenePreviewDialog } from './ScenePreviewDialog'

const toggle = vi.fn()
const seek = vi.fn()
const stop = vi.fn()
const capturedEvents: unknown[] = []

vi.mock('./usePreviewTransport', () => ({
  usePreviewTransport: (events: unknown) => {
    capturedEvents.push(events)
    return {
      playing: false,
      loading: false,
      failed: 0,
      clock: () => 0,
      toggle,
      seek,
      stop,
    }
  },
}))

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

function sheet(times: number[]): ContactSheet {
  return {
    dataUrl: '',
    url: 'sheet.jpg',
    times,
    interval: 1,
    width: 104,
    height: 32,
    cols: 2,
    rows: 1,
    cellWidth: 48,
    cellHeight: 27,
    gap: 2,
    count: times.length,
    bytes: 0,
    index: 0,
    total: 1,
  }
}

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    index: 0,
    sourceId: 'source-1',
    title: 'Intro',
    start: 0,
    end: 10,
    transcript: 'hello there',
    status: 'pending',
    narrationSeconds: null,
    cuts: [],
    refined: {
      source: 'manual',
      cuts: [],
      segments: [
        { text: 'hello', start: 0, end: 4, audioUrl: 'a.mp3', audioSeconds: 4 },
        { text: 'there', start: 6, end: 10 }, // unvoiced
      ],
    },
    ...over,
  }
}

describe('ScenePreviewDialog', () => {
  beforeEach(() => {
    toggle.mockClear()
    seek.mockClear()
    stop.mockClear()
    capturedEvents.length = 0
  })

  it('opens as a modal with the scene title and flags unvoiced runs', () => {
    render(<ScenePreviewDialog open onClose={() => {}} scene={scene()} sheets={[sheet([0, 5])]} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText(/Intro/)).toBeInTheDocument()
    expect(screen.getByText(/1 run unvoiced/)).toBeInTheDocument()
  })

  it('play button drives the transport', () => {
    render(<ScenePreviewDialog open onClose={() => {}} scene={scene()} sheets={[sheet([0, 5])]} />)
    fireEvent.click(screen.getByRole('button', { name: /play/i }))
    expect(toggle).toHaveBeenCalledOnce()
  })

  it('with no usable sheets it shows the no-frames placeholder (audio still previews)', () => {
    render(<ScenePreviewDialog open onClose={() => {}} scene={scene()} sheets={[]} />)
    expect(screen.getByText(/no frames captured/i)).toBeInTheDocument()
  })

  it('an all-cut scene disables play', () => {
    const s = scene({ refined: { source: 'manual', cuts: [{ start: 0, end: 10 }], segments: [] } })
    render(<ScenePreviewDialog open onClose={() => {}} scene={s} sheets={[sheet([0, 5])]} />)
    expect(screen.getByRole('button', { name: /play/i })).toBeDisabled()
  })

  it('closing the dialog stops the transport', () => {
    const { rerender } = render(
      <ScenePreviewDialog open onClose={() => {}} scene={scene()} sheets={[sheet([0, 5])]} />,
    )
    stop.mockClear()
    rerender(<ScenePreviewDialog open={false} onClose={() => {}} scene={scene()} sheets={[sheet([0, 5])]} />)
    expect(stop).toHaveBeenCalled()
  })

  it('passes referentially stable events to the transport across re-renders (the hook contract)', () => {
    const s = scene()
    const sheets = [sheet([0, 5])]
    const { rerender } = render(<ScenePreviewDialog open onClose={() => {}} scene={s} sheets={sheets} />)
    rerender(<ScenePreviewDialog open onClose={() => {}} scene={s} sheets={sheets} />)
    expect(capturedEvents.length).toBeGreaterThanOrEqual(2)
    expect(capturedEvents[capturedEvents.length - 1]).toBe(capturedEvents[0])
  })
})
