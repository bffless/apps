/**
 * `CodeView` (Task 16, 02): highlighted output for a registered language,
 * escaped plain text (no `hljs-*` spans, no innerHTML) for anything else.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeView } from './CodeView'

const JS_SOURCE = 'function greet() { return "hi"; }'

describe('CodeView', () => {
  it('highlights a registered language (javascript) with hljs-* spans', () => {
    const { container } = render(<CodeView value={JS_SOURCE} mapping={{ language: 'javascript' }} />)
    const el = screen.getByTestId('renderer')
    expect(el).toHaveAttribute('data-render', 'code')
    expect(el).toHaveAttribute('data-language', 'javascript')
    expect(container.querySelector('.hljs-keyword')).toBeTruthy()
  })

  it('falls back to escaped plain text for an unregistered language, with a label', () => {
    const { container } = render(<CodeView value={JS_SOURCE} mapping={{ language: 'cobol' }} />)
    const el = screen.getByTestId('renderer')
    expect(el).toHaveAttribute('data-render', 'code')
    expect(el).toHaveAttribute('data-language', 'cobol')
    expect(container.querySelectorAll('[class*="hljs-"]')).toHaveLength(0)
    expect(screen.getByText('cobol')).toBeInTheDocument()
    expect(el.textContent).toContain(JS_SOURCE)
  })

  it('falls back to plain text and a "plain" label when no language is given', () => {
    render(<CodeView value={JS_SOURCE} mapping={{}} />)
    const el = screen.getByTestId('renderer')
    expect(el).toHaveAttribute('data-language', '')
    expect(screen.getByText('plain')).toBeInTheDocument()
  })

  it('stringifies a non-string value before highlighting', () => {
    render(<CodeView value={{ a: 1 }} mapping={{ language: 'json' }} />)
    const el = screen.getByTestId('renderer')
    expect(el.textContent).toContain('"a"')
  })
})
