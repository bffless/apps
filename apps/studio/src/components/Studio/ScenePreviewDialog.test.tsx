import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { Scene } from '../../lib/scenes'
import type { ContactSheet } from '../../lib/frames'
import { ScenePreviewDialog } from './ScenePreviewDialog'

// jsdom lacks showModal/close — polyfill them as ContactDialog.test.tsx does;
// pause() dispatches the event a browser would.
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
  HTMLMediaElement.prototype.pause = function () {
    this.dispatchEvent(new Event('pause'))
  }
  HTMLMediaElement.prototype.play = function () {
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
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
    cuts: [],
    refined: { source: 'manual', cuts: [{ start: 4, end: 6 }] },
    ...over,
  }
}

describe('ScenePreviewDialog (cut-first, ADR-0003)', () => {
  it('shows the stitched output length (footage minus cuts)', () => {
    render(
      <ScenePreviewDialog
        open
        onClose={() => {}}
        scene={scene()}
        sheets={[sheet([0, 5])]}
        audioUrl="blob:audio"
      />,
    )
    // 10s scene with a 2s cut → 8s output
    expect(screen.getByText('0:00 / 0:08')).toBeInTheDocument()
  })

  it('play jumps the playhead over a cut as the audio reaches it', () => {
    render(
      <ScenePreviewDialog
        open
        onClose={() => {}}
        scene={scene()}
        sheets={[]}
        audioUrl="blob:audio"
      />,
    )
    const audio = document.querySelector('audio')!
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    // Simulate the clock landing inside the cut (source second 5): the handler
    // must seek to the next kept span (source second 6).
    Object.defineProperty(audio, 'currentTime', { value: 5, writable: true, configurable: true })
    fireEvent.timeUpdate(audio)
    expect(audio.currentTime).toBe(6)
  })

  it('disables Play when everything is cut', () => {
    const allCut = scene({ refined: { source: 'manual', cuts: [{ start: 0, end: 10 }] } })
    render(
      <ScenePreviewDialog open onClose={() => {}} scene={allCut} sheets={[]} audioUrl="blob:audio" />,
    )
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByText(/Everything in this scene is cut/)).toBeInTheDocument()
  })

  it('disables Play (frames only) when there is no extracted audio', () => {
    render(<ScenePreviewDialog open onClose={() => {}} scene={scene()} sheets={[]} />)
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByText(/No extracted audio/)).toBeInTheDocument()
  })

  it('close button calls onClose', () => {
    const onClose = vi.fn()
    render(
      <ScenePreviewDialog open onClose={onClose} scene={scene()} sheets={[]} audioUrl="blob:audio" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(onClose).toHaveBeenCalled()
  })
})
