import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { BlogCard } from './BlogCard'
import type { BlogPost } from '../../store/studioSlice'

const post = (over: Partial<BlogPost> = {}): BlogPost => ({
  markdown: '',
  direction: '',
  script: 'the final script',
  status: 'idle',
  jobId: null,
  ...over,
})

describe('BlogCard', () => {
  it('generates with the typed direction (on demand)', () => {
    const onGenerate = vi.fn()
    render(<BlogCard post={null} generating={false} onGenerate={onGenerate} />)

    fireEvent.change(screen.getByLabelText(/Direction/i), { target: { value: 'keep it punchy' } })
    fireEvent.click(screen.getByRole('button', { name: /Generate/i }))

    expect(onGenerate).toHaveBeenCalledWith('keep it punchy')
  })

  it('shows a running status and disables the button while generating', () => {
    render(<BlogCard post={post({ status: 'running' })} generating onGenerate={vi.fn()} />)
    expect(screen.getByText(/Writing your post/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generating/i })).toBeDisabled()
  })

  it('renders the generated markdown read-only (no editor) and offers Regenerate', () => {
    render(
      <BlogCard
        post={post({ status: 'done', markdown: '---\ntitle: My Post\n---\n\n# My Post\n\nHello **world**.' })}
        generating={false}
        onGenerate={vi.fn()}
      />,
    )
    // The front-matter title + heading render; the body is shown, not an editor.
    expect(screen.getAllByText('My Post').length).toBeGreaterThan(0)
    expect(screen.getByText('world')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /post|markdown/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeInTheDocument()
  })

  it('surfaces an error status', () => {
    render(<BlogCard post={post({ status: 'error' })} generating={false} onGenerate={vi.fn()} />)
    expect(screen.getByText(/Generation failed/i)).toBeInTheDocument()
  })
})
