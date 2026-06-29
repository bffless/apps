import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MarkdownPreview } from './MarkdownPreview'

describe('MarkdownPreview inline images (issue #70)', () => {
  it('renders a standalone image line as an <img> with its caption shown visibly', () => {
    render(
      <MarkdownPreview markdown={'Intro.\n\n![The rule diff](/api/uploads/blog/p/blog/frame-01.jpg)\n\nMore prose.'} />,
    )
    const img = screen.getByRole('img', { name: 'The rule diff' })
    expect(img).toHaveAttribute('src', '/api/uploads/blog/p/blog/frame-01.jpg')
    // The caption is also surfaced visibly (a figcaption), not just as alt text.
    expect(screen.getByText('The rule diff')).toBeInTheDocument()
  })

  it('still renders surrounding prose around the image', () => {
    render(<MarkdownPreview markdown={'Before.\n\n![Result](/u/frame-02.jpg)\n\nAfter.'} />)
    expect(screen.getByText('Before.')).toBeInTheDocument()
    expect(screen.getByText('After.')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Result' })).toBeInTheDocument()
  })
})
