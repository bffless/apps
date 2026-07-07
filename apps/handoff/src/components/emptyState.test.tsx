import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('signed-out guest at root: public-empty copy + Sign in', () => {
    const onSignIn = vi.fn()
    render(
      <EmptyState canWrite={false} isRoot signedOut onNew={() => {}} onSignIn={onSignIn} />,
    )
    expect(screen.getByText('Nothing public here')).toBeInTheDocument()
    expect(screen.getByText('Sign in to view your team’s content.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onSignIn).toHaveBeenCalledOnce()
  })

  it('signed-in writer at root keeps the upload copy', () => {
    render(<EmptyState canWrite isRoot signedOut={false} onNew={() => {}} onSignIn={() => {}} />)
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload files/ })).toBeInTheDocument()
  })

  it('signed-out guest in a public but empty sub-folder keeps the plain copy', () => {
    render(
      <EmptyState canWrite={false} isRoot={false} signedOut onNew={() => {}} onSignIn={() => {}} />,
    )
    expect(screen.getByText('This folder is empty')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})
