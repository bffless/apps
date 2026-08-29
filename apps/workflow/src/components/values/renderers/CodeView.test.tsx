/**
 * `CodeView` (Task 16, 02): highlighted output for a registered language,
 * escaped plain text (no `hljs-*` spans, no innerHTML) for anything else —
 * and, since apps#380, one numbered `.code-line` per source line on both
 * paths rather than only on the plain one.
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

  it('emits one .code-line per source line on the highlighted path', () => {
    const source = ['const a = 1', 'const b = 2', 'const c = 3'].join('\n')
    const { container } = render(<CodeView value={source} mapping={{ language: 'javascript' }} />)

    const lines = container.querySelectorAll('.code-line')
    expect(lines).toHaveLength(3)
    expect(lines[0].textContent).toBe('const a = 1')
    expect(lines[2].textContent).toBe('const c = 3')
    // Still highlighted, not flattened into plain text by the split.
    expect(container.querySelector('.code-line .hljs-keyword')).toBeTruthy()
  })

  it('numbers a line that a token span straddles, keeping the span on both halves', () => {
    const source = '/* one\n   two */\nconst x = 1'
    const { container } = render(<CodeView value={source} mapping={{ language: 'javascript' }} />)

    const lines = [...container.querySelectorAll('.code-line')]
    expect(lines).toHaveLength(3)
    expect(lines[0].querySelector('.hljs-comment')).toBeTruthy()
    expect(lines[1].querySelector('.hljs-comment')).toBeTruthy()
    expect(lines.map((el) => el.textContent)).toEqual(['/* one', '   two */', 'const x = 1'])
  })

  it('emits one .code-line per source line on the plain path too', () => {
    const { container } = render(<CodeView value={'a\nb'} mapping={{ language: 'cobol' }} />)
    expect(container.querySelectorAll('.code-line')).toHaveLength(2)
  })

  it('stringifies a non-string value before highlighting', () => {
    render(<CodeView value={{ a: 1 }} mapping={{ language: 'json' }} />)
    const el = screen.getByTestId('renderer')
    expect(el.textContent).toContain('"a"')
  })
})
