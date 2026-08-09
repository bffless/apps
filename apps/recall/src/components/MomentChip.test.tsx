import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MomentChip } from './MomentChip'
import type { SheetMeta } from '../lib/sprite'

const MOMENT = { start: 32, snippet: 'hello world', similarity: 0.9 }

const META: SheetMeta = {
  cols: 5,
  rows: 2,
  tileW: 320,
  tileH: 180,
  tiles: [{ t: 0 }, { t: 10 }, { t: 20 }, { t: 30 }, { t: 40 }, { t: 50 }, { t: 60 }, { t: 70 }, { t: 80 }, { t: 90 }],
}

describe('MomentChip', () => {
  it('renders no sprite thumbnail when sheetUrl/sheetMeta are absent', () => {
    render(<MomentChip moment={MOMENT} onSelect={vi.fn()} />)
    expect(screen.getByText('0:32')).toBeInTheDocument()
    expect(document.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument()
  })

  it('renders a cropped sprite thumbnail when a sheet is present, nearest to moment.start', () => {
    render(
      <MomentChip
        moment={MOMENT}
        sheetUrl="/api/uploads/sheets/v1/x.jpg"
        sheetMeta={META}
        onSelect={vi.fn()}
      />,
    )
    const thumb = document.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(thumb).toBeInTheDocument()
    expect(thumb.style.backgroundImage).toBe('url("/api/uploads/sheets/v1/x.jpg")')
    // moment.start=32 is nearest to tile 3 (t=30) -> col 3, row 0 at displayW 112.
    expect(thumb.style.backgroundPosition).toBe('-336px 0px')
  })

  it('calls onSelect with the moment when clicked', () => {
    const onSelect = vi.fn()
    render(<MomentChip moment={MOMENT} onSelect={onSelect} />)
    screen.getByRole('button').click()
    expect(onSelect).toHaveBeenCalledWith(MOMENT)
  })
})
