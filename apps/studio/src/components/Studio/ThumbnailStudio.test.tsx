import type { ComponentProps } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import { ThumbnailStudio } from './ThumbnailStudio'

/**
 * The optional reference image: the creator uploads a shot of their own face (or
 * a product) and nano-banana works from it, which is the whole point — a
 * generated thumbnail with the creator in it. The upload rides the existing
 * presigned `/api/uploads/thumbnails` flow, so the component only ever handles
 * the returned serve path.
 */
type Props = ComponentProps<typeof ThumbnailStudio>

const baseProps: Props = {
  title: 'Vibe Coding Inline Comments',
  description: 'A video about comments',
  thumbnail: null,
  drafting: false,
  rendering: false,
  onDraft: vi.fn(async () => 'drafted prompt'),
  onRender: vi.fn(),
  onUploadReference: vi.fn(async () => '/api/uploads/thumbnails/face.png'),
  signFor: vi.fn(async (url: string) => `https://bucket.test${url}?sig=1`),
}

function props(overrides: Partial<Props> = {}): Props {
  return { ...baseProps, ...overrides }
}

const pngFile = () => new File(['bytes'], 'face.png', { type: 'image/png' })

describe('ThumbnailStudio reference image', () => {
  it('uploads a picked image and passes its serve path to onRender', async () => {
    const onRender = vi.fn()
    const onUploadReference = vi.fn<(file: File) => Promise<string>>(
      async () => '/api/uploads/thumbnails/face.png',
    )
    render(
      <ThumbnailStudio
        {...props({ onRender, onUploadReference, thumbnail: { notes: '', prompt: 'p', url: '' } })}
      />,
    )

    fireEvent.change(screen.getByLabelText(/reference image/i), { target: { files: [pngFile()] } })

    await waitFor(() => expect(onUploadReference).toHaveBeenCalled())
    expect(onUploadReference.mock.calls[0][0]).toBeInstanceOf(File)

    fireEvent.click(screen.getByRole('button', { name: /regenerate|generate/i }))
    expect(onRender).toHaveBeenCalledWith('', 'p', '/api/uploads/thumbnails/face.png')
  })

  it('passes null when no reference image was picked', async () => {
    const onRender = vi.fn()
    render(<ThumbnailStudio {...props({ onRender, thumbnail: { notes: '', prompt: 'p', url: '' } })} />)

    fireEvent.click(screen.getByRole('button', { name: /regenerate|generate/i }))

    expect(onRender).toHaveBeenCalledWith('', 'p', null)
  })

  it('restores a persisted reference image and can remove it', async () => {
    const onRender = vi.fn()
    render(
      <ThumbnailStudio
        {...props({
          onRender,
          thumbnail: {
            notes: '',
            prompt: 'p',
            url: '',
            referenceUrl: '/api/uploads/thumbnails/saved.png',
          },
        })}
      />,
    )

    // Shown as a preview via the signed URL, never the raw serve path.
    await waitFor(() =>
      expect(screen.getByAltText(/reference/i)).toHaveAttribute(
        'src',
        'https://bucket.test/api/uploads/thumbnails/saved.png?sig=1',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: /remove reference/i }))
    fireEvent.click(screen.getByRole('button', { name: /regenerate|generate/i }))

    expect(onRender).toHaveBeenCalledWith('', 'p', null)
  })

  it('surfaces an upload failure instead of silently generating without the image', async () => {
    const onUploadReference = vi.fn<(file: File) => Promise<string>>(async () => {
      throw new Error('Bucket upload failed (403)')
    })
    render(
      <ThumbnailStudio
        {...props({ onUploadReference, thumbnail: { notes: '', prompt: 'p', url: '' } })}
      />,
    )

    fireEvent.change(screen.getByLabelText(/reference image/i), { target: { files: [pngFile()] } })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/403/))
  })

  it('exposes the headless-contract test-ids and data-states', async () => {
    const { rerender } = render(<ThumbnailStudio {...props()} />)
    const card = screen.getByTestId('thumbnail-studio')
    expect(card).toHaveAttribute('data-state', 'idle')
    expect(screen.getByTestId('thumb-notes')).toBeInTheDocument()
    expect(screen.getByTestId('thumb-draft')).toBeInTheDocument()
    expect(screen.getByTestId('thumb-reference')).toBeInTheDocument()
    expect(screen.getByTestId('thumb-prompt')).toBeInTheDocument()
    expect(screen.getByTestId('thumb-render')).toBeInTheDocument()

    rerender(<ThumbnailStudio {...props({ drafting: true })} />)
    expect(card).toHaveAttribute('data-state', 'drafting')
    rerender(<ThumbnailStudio {...props({ rendering: true })} />)
    expect(card).toHaveAttribute('data-state', 'rendering')
    rerender(
      <ThumbnailStudio
        {...props({ thumbnail: { notes: '', prompt: 'p', url: '/api/uploads/t.png' } })}
      />,
    )
    expect(card).toHaveAttribute('data-state', 'done')
    // The rendered result carries its own id so the runner can read the signed src.
    await waitFor(() => expect(screen.getByTestId('thumb-result')).toHaveAttribute('src'))
  })

  it('marks the reference preview so the runner can await the upload', async () => {
    render(
      <ThumbnailStudio
        {...props({
          thumbnail: { notes: '', prompt: 'p', url: '', referenceUrl: '/api/uploads/thumbnails/saved.png' },
        })}
      />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('thumb-reference-preview')).toHaveAttribute('src'),
    )
  })

  // The render step always forwards the reference to nano-banana — but the model
  // only uses it if the PROMPT says so, and a prompt drafted blind bans
  // photorealistic humans. So the draft call has to carry the flag.
  it('tells the drafter a reference is attached', async () => {
    const onDraft = vi.fn<Props['onDraft']>(async () => 'drafted prompt')
    render(<ThumbnailStudio {...props({ onDraft })} />)

    fireEvent.change(screen.getByLabelText(/reference image/i), { target: { files: [pngFile()] } })
    await waitFor(() => expect(screen.getByTestId('thumb-reference-preview')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('thumb-draft'))
    await waitFor(() => expect(onDraft).toHaveBeenCalled())
    expect(onDraft).toHaveBeenCalledWith(
      'Vibe Coding Inline Comments',
      'A video about comments',
      '',
      true,
    )
  })

  it('passes false when drafting with no reference attached', async () => {
    const onDraft = vi.fn<Props['onDraft']>(async () => 'drafted prompt')
    render(<ThumbnailStudio {...props({ onDraft })} />)

    fireEvent.click(screen.getByTestId('thumb-draft'))

    await waitFor(() => expect(onDraft).toHaveBeenCalled())
    expect(onDraft.mock.calls[0][3]).toBe(false)
  })

  // Attaching after drafting is the trap that shipped a thumbnail with no
  // creator in it: the photo is uploaded and sent, and the prompt never mentions
  // it. Warn instead of silently rendering the wrong image.
  it('warns when the reference was attached after the prompt was drafted', async () => {
    render(<ThumbnailStudio {...props()} />)

    fireEvent.click(screen.getByTestId('thumb-draft'))
    await waitFor(() => expect(screen.getByTestId('thumb-prompt')).toHaveValue('drafted prompt'))
    expect(screen.queryByTestId('thumb-reference-stale')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/reference image/i), { target: { files: [pngFile()] } })

    await waitFor(() =>
      expect(screen.getByTestId('thumb-reference-stale')).toHaveTextContent(/re-draft/i),
    )
  })

  it('rejects a non-image file before uploading anything', async () => {
    const onUploadReference = vi.fn<(file: File) => Promise<string>>(async () => '')
    render(
      <ThumbnailStudio
        {...props({ onUploadReference, thumbnail: { notes: '', prompt: 'p', url: '' } })}
      />,
    )

    fireEvent.change(screen.getByLabelText(/reference image/i), { target: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] } })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/image/i))
    expect(onUploadReference).not.toHaveBeenCalled()
  })
})
