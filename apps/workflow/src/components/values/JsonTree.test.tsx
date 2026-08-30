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

// apps#450: with `shapes`, a node whose value has a shape (02 "Inferred
// shapes") is drawn by that shape's viewer in place of a subtree; without it
// (the Raw flip) the same value is nodes and leaves all the way down.
describe('JsonTree — shaped nodes', () => {
  const value = {
    outPrefix: 'workflows/studio/long-to-short/runs/run_01M17/per-scene/0/assemble',
    times: [1.68166, 5.03, 8.39],
    spans: [
      { start: 8.52, end: 10.48 },
      { start: 12.1, end: 14 },
    ],
    plain: { a: 1, b: 'two' },
  }

  it('draws a shaped node with its viewer under its key, and a plain node as a subtree', () => {
    const { container } = render(<JsonTree value={value} shapes />)
    const shaped = container.querySelectorAll('[data-testid="json-shaped"]')
    expect([...shaped].map((node) => node.getAttribute('data-shape'))).toEqual(['path', 'list', 'table'])
    expect(shaped[0].querySelector('.json-key')?.textContent).toBe('outPrefix: ')
    expect(shaped[0].querySelector('.value-path-name')?.textContent).toBe('assemble')
    expect(shaped[1].textContent).toContain('1.68, 5.03, 8.39')
    expect(shaped[2].querySelector('table')).toBeTruthy()
    // The plain object is still a `<details>` node with two leaves.
    const plain = [...container.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent?.startsWith('plain'))
    expect(plain?.querySelectorAll('.json-leaf')).toHaveLength(2)
  })

  it('draws every node as a node without `shapes`', () => {
    const { container } = render(<JsonTree value={value} />)
    expect(container.querySelector('[data-testid="json-shaped"]')).toBeNull()
    expect(container.querySelector('table')).toBeNull()
    // outPrefix, three times, two spans × two, a, b
    expect(container.querySelectorAll('.json-leaf')).toHaveLength(1 + 3 + 4 + 2)
  })
})
