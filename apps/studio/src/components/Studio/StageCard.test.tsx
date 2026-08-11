import { render, screen } from '@testing-library/react'
import { it, expect } from 'vitest'
import { StageCard } from './StageCard'
import type { Stage } from '../../lib/pipeline'

function stage(over: Partial<Stage> = {}): Stage {
  return {
    id: 'thumbnails',
    title: 'Sample & save director thumbnails',
    note: 'Grab frames across the whole clip.',
    where: 'browser+pipeline',
    scope: 'global',
    actionLabel: 'Generate thumbnails',
    status: 'pending',
    ...over,
  }
}

it('exposes stage-<id> for a global stage, mapping active to running', () => {
  render(<StageCard stage={stage({ id: 'thumbnails', status: 'active' })} index={0} />)
  const el = screen.getByTestId('stage-thumbnails')
  expect(el.dataset.state).toBe('running')
})

it('maps pending/done/error the same way as the per-video badges', () => {
  const { rerender } = render(<StageCard stage={stage({ id: 'director', status: 'pending' })} index={1} />)
  expect(screen.getByTestId('stage-director').dataset.state).toBe('pending')

  rerender(<StageCard stage={stage({ id: 'director', status: 'done' })} index={1} />)
  expect(screen.getByTestId('stage-director').dataset.state).toBe('done')

  rerender(<StageCard stage={stage({ id: 'director', status: 'error' })} index={1} />)
  expect(screen.getByTestId('stage-director').dataset.state).toBe('error')
})
