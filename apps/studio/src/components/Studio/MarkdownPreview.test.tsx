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

describe('MarkdownPreview inline links', () => {
  it('renders a Markdown link inside prose as an <a> that opens in a new tab', () => {
    render(
      <MarkdownPreview
        markdown={'We wired up the [MCP server](https://docs.bffless.app/features/mcp-server/) step.'}
      />,
    )
    const link = screen.getByRole('link', { name: 'MCP server' })
    expect(link).toHaveAttribute('href', 'https://docs.bffless.app/features/mcp-server/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // The raw Markdown syntax must NOT leak into the rendered text.
    expect(screen.queryByText(/\]\(https/)).not.toBeInTheDocument()
  })

  it('renders a link alongside other inline formatting', () => {
    render(
      <MarkdownPreview markdown={'See **bold** and [the docs](https://docs.bffless.app/) here.'} />,
    )
    expect(screen.getByRole('link', { name: 'the docs' })).toHaveAttribute(
      'href',
      'https://docs.bffless.app/',
    )
    expect(screen.getByText('bold')).toBeInTheDocument()
  })

  it('does not turn a standalone image line into a link (stays a figure)', () => {
    render(<MarkdownPreview markdown={'![A frame](/api/uploads/blog/frame-03.jpg)'} />)
    expect(screen.getByRole('img', { name: 'A frame' })).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
