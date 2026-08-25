/**
 * The final whole-branch review (I4): the `json` viewer is the fallback for any
 * unrecognized value, and a script step can legitimately return an array with
 * tens of thousands of entries. Rendering one node per entry put ~100k DOM
 * nodes on the run page, so the tree renders at most `MAX_ENTRIES` children and
 * says how many it left out.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { JsonTree, MAX_ENTRIES } from './JsonTree'

describe('JsonTree', () => {
  it('renders a small array in full, with no "more entries" marker', () => {
    const { container } = render(<JsonTree value={[1, 2, 3]} />)
    expect(container.querySelectorAll('.json-leaf')).toHaveLength(3)
    expect(screen.queryByTestId('json-more')).toBeNull()
  })

  it('caps a long array and reports the remainder', () => {
    const value = Array.from({ length: MAX_ENTRIES + 42 }, (_, i) => i)
    const { container } = render(<JsonTree value={value} />)

    // The root summary still reports the *real* length — the value is all there.
    expect(container.querySelector('summary')?.textContent).toContain(`[${MAX_ENTRIES + 42}]`)
    expect(container.querySelectorAll('.json-leaf')).toHaveLength(MAX_ENTRIES)
    expect(screen.getByTestId('json-more')).toHaveTextContent('42 more entries')
  })

  it('caps a wide object and reports the remainder', () => {
    const value = Object.fromEntries(
      Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, i]),
    )
    const { container } = render(<JsonTree value={value} />)

    expect(container.querySelector('summary')?.textContent).toContain(`{${MAX_ENTRIES + 1}}`)
    expect(container.querySelectorAll('.json-leaf')).toHaveLength(MAX_ENTRIES)
    expect(screen.getByTestId('json-more')).toHaveTextContent('1 more entry')
  })
})
