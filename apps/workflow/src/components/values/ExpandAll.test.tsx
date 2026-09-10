/**
 * The bar over a list of folded values. Its one subtlety is the empty case:
 * `count` is how many values *fold*, not how many there are, so a pane of
 * short scalars — a `form` step's three evaluated inputs, say — has a count of
 * zero. A bar there would read "3 inputs · Expand all" over a pane where
 * pressing it changes nothing, which is the shape the 2026-09-09 round-2
 * review called a control that does nothing.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ExpandAll } from './ExpandAll'

describe('ExpandAll', () => {
  it('renders nothing when no value in the pane folds, however many there are', () => {
    const { container } = render(<ExpandAll total={3} foldable={0} unit="input" open={false} onToggle={() => {}} />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('values-expand-all')).toBeNull()
  })

  it('labels the pane with every value, not only the ones that fold', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<ExpandAll total={3} foldable={2} unit="output" open={false} onToggle={onToggle} />)

    expect(screen.getByText('3 outputs')).toBeInTheDocument()
    const button = screen.getByTestId('values-expand-all')
    expect(button).toHaveTextContent('Expand all')
    expect(button).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledOnce()

    rerender(<ExpandAll total={3} foldable={2} unit="output" open onToggle={onToggle} />)
    expect(screen.getByTestId('values-expand-all')).toHaveTextContent('Collapse all')
    expect(screen.getByTestId('values-expand-all')).toHaveAttribute('aria-pressed', 'true')
  })

  it('says "1 input", not "1 inputs"', () => {
    render(<ExpandAll total={1} foldable={1} unit="input" open={false} onToggle={() => {}} />)
    expect(screen.getByText('1 input')).toBeInTheDocument()
  })
})
