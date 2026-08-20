/**
 * A render exception in one screen must cost that screen, not the harness:
 * before this boundary existed, anything thrown below `<Outlet/>` unmounted
 * the whole tree and left a blank page with no way back.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Shell } from './Shell'
import { makeStore } from '../store'

/** React logs every error a boundary catches; that is noise, not a failure. */
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

let shouldThrow = true

function Boom() {
  if (shouldThrow) throw new Error('row[c.key] of null')
  return <p>recovered</p>
}

function renderShell() {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={['/hello']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path=":impl" element={<Boom />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true
  })

  it('shows the failure card and keeps the shell around it when a screen throws', async () => {
    renderShell()

    expect(screen.getByText('Something went wrong rendering this page')).toBeInTheDocument()
    expect(screen.getByText('row[c.key] of null')).toBeInTheDocument()
    // The frame survives: the rail still lists what discovery found.
    expect(await screen.findByRole('link', { name: 'Hello' })).toBeInTheDocument()
  })

  it('re-renders the screen when Try again is pressed', () => {
    renderShell()

    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('recovered')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong rendering this page')).not.toBeInTheDocument()
  })
})
