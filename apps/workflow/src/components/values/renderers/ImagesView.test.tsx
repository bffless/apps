/**
 * `ImagesView` (Task 15, 02): a grid of image refs, falling back to
 * `FileCard` for a non-image ref (or an image ref whose url fails the
 * same-origin gate) and to `JsonTree` for anything that isn't a File ref.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FileRef } from '../../../lib/runner/types'
import { ImagesView } from './ImagesView'

function ref(over: Partial<FileRef>): FileRef {
  return {
    path: 'p',
    name: 'file',
    contentType: 'image/png',
    size: 10,
    url: '/api/uploads/x',
    ...over,
  }
}

describe('ImagesView', () => {
  it('renders 2 image refs as 2 <img> elements, each with a Download link', () => {
    const refs = [
      ref({ name: 'a.png', url: '/api/uploads/a.png' }),
      ref({ name: 'b.png', url: '/api/uploads/b.png' }),
    ]
    const { container } = render(<ImagesView value={refs} />)
    const wrapper = screen.getByTestId('renderer')
    expect(wrapper).toHaveAttribute('data-render', 'images')

    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(2)
    expect(imgs[0].getAttribute('src')).toBe('/api/uploads/a.png')
    expect(imgs[1].getAttribute('src')).toBe('/api/uploads/b.png')

    const downloads = screen.getAllByText('Download') as HTMLAnchorElement[]
    expect(downloads).toHaveLength(2)
    expect(downloads[0].getAttribute('href')).toBe('/api/uploads/a.png?download=1')
  })

  it('renders an image/png ref as an <img> and an application/pdf ref as a FileCard', () => {
    const refs = [
      ref({ name: 'pic.png', contentType: 'image/png', url: '/api/uploads/pic.png' }),
      ref({ name: 'doc.pdf', contentType: 'application/pdf', url: '/api/uploads/doc.pdf' }),
    ]
    const { container } = render(<ImagesView value={refs} />)
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.querySelectorAll('.file-card')).toHaveLength(1)
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()
  })

  it('renders one File ref (not wrapped in an array) as a single image', () => {
    const { container } = render(<ImagesView value={ref({ name: 'solo.png' })} />)
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('falls back to FileCard for an image ref whose url is not same-origin', () => {
    // FileCard's own player still shows an <img> here — it gates on
    // `isSafeUrl` (Task 23's concern), not `isSameOriginUrl`. What Task 15
    // owns is that ImagesView itself declines to build its own grid tile
    // (and its own same-origin `src`) for this ref, deferring to FileCard.
    const { container } = render(
      <ImagesView value={ref({ name: 'off.png', url: 'https://other.example/off.png' })} />,
    )
    expect(container.querySelectorAll('.images-grid-item')).toHaveLength(0)
    expect(container.querySelectorAll('.file-card')).toHaveLength(1)
    expect(screen.getByText('off.png')).toBeInTheDocument()
  })

  it('falls back to JsonTree for a non-ref item', () => {
    const { container } = render(<ImagesView value={[{ nope: true }]} />)
    expect(container.querySelector('details')).toBeTruthy()
  })
})
