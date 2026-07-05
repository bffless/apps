import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Pager } from './Pager'

/**
 * The Pager is a pure URL-driven control (the page lives in `?page=n`): given a
 * `page` / `totalPages` it renders the number strip + prev/next and reports the
 * target page via `onPage`. These assert it hides itself for a single page,
 * renders the right buttons, calls back with the correct target, disables
 * prev/next at the ends, and marks the current page (as an inert `aria-current`).
 */

describe('Pager', () => {
  it('renders nothing when there is a single page (or none)', () => {
    const { container } = render(<Pager page={1} totalPages={1} onPage={() => {}} />)
    expect(container.firstChild).toBeNull()
    const zero = render(<Pager page={1} totalPages={0} onPage={() => {}} />)
    expect(zero.container.firstChild).toBeNull()
  })

  it('renders a numbered button per page for a small set', () => {
    render(<Pager page={1} totalPages={3} onPage={() => {}} />)
    expect(screen.getByRole('button', { name: 'Page 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page 3' })).toBeInTheDocument()
  })

  it('marks the current page with aria-current and makes it a no-op', () => {
    const onPage = vi.fn()
    render(<Pager page={2} totalPages={3} onPage={onPage} />)
    const current = screen.getByRole('button', { name: 'Page 2' })
    expect(current).toHaveAttribute('aria-current', 'page')
    current.click()
    expect(onPage).not.toHaveBeenCalled()
  })

  it('calls onPage with the clicked page number', () => {
    const onPage = vi.fn()
    render(<Pager page={1} totalPages={3} onPage={onPage} />)
    screen.getByRole('button', { name: 'Page 3' }).click()
    expect(onPage).toHaveBeenCalledWith(3)
  })

  it('prev/next step to the neighboring page', () => {
    const onPage = vi.fn()
    render(<Pager page={2} totalPages={3} onPage={onPage} />)
    screen.getByRole('button', { name: 'Previous page' }).click()
    expect(onPage).toHaveBeenLastCalledWith(1)
    screen.getByRole('button', { name: 'Next page' }).click()
    expect(onPage).toHaveBeenLastCalledWith(3)
  })

  it('disables prev on the first page', () => {
    render(<Pager page={1} totalPages={3} onPage={() => {}} />)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled()
  })

  it('disables next on the last page', () => {
    render(<Pager page={3} totalPages={3} onPage={() => {}} />)
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled()
  })

  it('windows a large set with ellipsis gaps (first/last + neighbors)', () => {
    render(<Pager page={5} totalPages={10} onPage={() => {}} />)
    // First, last, current, and immediate neighbors are shown…
    for (const n of [1, 4, 5, 6, 10]) {
      expect(screen.getByRole('button', { name: `Page ${n}` })).toBeInTheDocument()
    }
    // …but far-off pages are collapsed behind the ellipsis.
    expect(screen.queryByRole('button', { name: 'Page 2' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Page 8' })).toBeNull()
  })
})
