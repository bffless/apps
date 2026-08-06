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
