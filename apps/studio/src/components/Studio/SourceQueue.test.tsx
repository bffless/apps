import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SourceQueue } from './SourceQueue'
import type { VideoSource } from '../../store/studioSlice'

// useSignDownloadQuery is called unconditionally inside SourceRow; mock it so
// we don't need a full Redux Provider + RTK Query setup in tests. The mock
// returns no signed URL (the preview <video> therefore never renders), but the
// audio and transcript sections render purely from slice state — which is what
// the test asserts.
vi.mock('../../store/studioApi', () => ({
  useSignDownloadQuery: () => ({ data: undefined }),
}))

const src = (id: string, order: number, fileName: string): VideoSource => ({
  id, order, fileName, duration: 60, sourceUrl: null, audioUrl: null, audioPeaks: [], words: [],
  stageProgress: { upload: { status: 'pending' }, extract: { status: 'pending' }, transcribe: { status: 'pending' } },
})

describe('SourceQueue', () => {
  const sources = [src('v1', 0, 'a.mp4'), src('v2', 1, 'b.mp4')]

  it('lists every source by filename in order', () => {
    render(<SourceQueue sources={sources} onReorder={vi.fn()} onRemove={vi.fn()} onProcess={vi.fn()} onProcessAll={vi.fn()} onAdd={vi.fn()} busyId={null} />)
    const names = screen.getAllByTestId('source-name').map((n) => n.textContent)
    expect(names).toEqual(['a.mp4', 'b.mp4'])
  })

  it('fires onProcess with the source id', () => {
    const onProcess = vi.fn()
    render(<SourceQueue sources={sources} onReorder={vi.fn()} onRemove={vi.fn()} onProcess={onProcess} onProcessAll={vi.fn()} onAdd={vi.fn()} busyId={null} />)
    fireEvent.click(screen.getAllByRole('button', { name: /process this video/i })[0])
    expect(onProcess).toHaveBeenCalledWith('v1')
  })

  it('fires onRemove with the source id', () => {
    const onRemove = vi.fn()
    render(<SourceQueue sources={sources} onReorder={vi.fn()} onRemove={onRemove} onProcess={vi.fn()} onProcessAll={vi.fn()} onAdd={vi.fn()} busyId={null} />)
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[1])
    expect(onRemove).toHaveBeenCalledWith('v2')
  })

  it('shows a Show preview toggle for a processed source and reveals transcript on click', () => {
    const processed: VideoSource = {
      id: 'v3',
      order: 0,
      fileName: 'c.mp4',
      duration: 90,
      sourceUrl: '/api/uploads/source/x',
      audioUrl: null,
      audioPeaks: [],
      words: [{ text: 'hi', start: 0, end: 1 }],
      stageProgress: {
        upload: { status: 'done' },
        extract: { status: 'done' },
        transcribe: { status: 'done' },
      },
    }
    render(
      <SourceQueue
        sources={[processed]}
        onReorder={vi.fn()}
        onRemove={vi.fn()}
        onProcess={vi.fn()}
        onProcessAll={vi.fn()}
        onAdd={vi.fn()}
        busyId={null}
      />,
    )

    // Toggle should be present and collapsed
    const toggle = screen.getByRole('button', { name: /show preview/i })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Transcript is not visible yet
    expect(screen.queryByText('hi')).not.toBeInTheDocument()

    // Click to expand
    fireEvent.click(toggle)

    // Toggle now says Hide preview and is expanded
    expect(screen.getByRole('button', { name: /hide preview/i })).toHaveAttribute('aria-expanded', 'true')

    // Transcript word is now visible
    expect(screen.getByText('hi')).toBeInTheDocument()
  })

  it('does not show the expand toggle for an unprocessed source', () => {
    render(
      <SourceQueue sources={[src('v4', 0, 'd.mp4')]} onReorder={vi.fn()} onRemove={vi.fn()} onProcess={vi.fn()} onProcessAll={vi.fn()} onAdd={vi.fn()} busyId={null} />,
    )
    expect(screen.queryByRole('button', { name: /show preview/i })).not.toBeInTheDocument()
  })

  it('fires onAdd with valid dropped video files', () => {
    const onAdd = vi.fn()
    render(<SourceQueue sources={sources} onReorder={vi.fn()} onRemove={vi.fn()} onProcess={vi.fn()} onProcessAll={vi.fn()} onAdd={onAdd} busyId={null} />)
    const strip = screen.getByText(/drop more clips here/i)
    const file = new File(['x'], 'c.mp4', { type: 'video/mp4' })
    fireEvent.drop(strip, { dataTransfer: { files: [file] } })
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd.mock.calls[0][0].map((f: File) => f.name)).toEqual(['c.mp4'])
  })
})
