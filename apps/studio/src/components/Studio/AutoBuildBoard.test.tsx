import { it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AutoBuildBoard } from './AutoBuildBoard'

const idleRun = { status: 'idle', active: [], halt: null } as never

it('exposes the run status for automation', () => {
  render(
    <AutoBuildBoard scenes={[]} run={idleRun} selectedId={null}
      onSelect={() => {}} onStart={() => {}} onPause={() => {}}
      onResume={() => {}} onStop={() => {}} />,
  )
  expect(screen.getByTestId('auto-build-board').dataset.state).toBe('idle')
  expect(screen.getByTestId('auto-build-start')).toBeInTheDocument()
})
