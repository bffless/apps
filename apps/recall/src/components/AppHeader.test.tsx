/**
 * Global header: brand link home on every page, admin nav only for admins,
 * GitHub source link top-right, and a user menu that shows who's signed in
 * (or a sign-in path for guests). Session state is mocked at the `useSession`
 * seam — the header's job is presentation, not session resolution.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Session } from '../lib/auth'
import { AppHeader } from './AppHeader'

const mockUseSession = vi.fn()

vi.mock('../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth')>()
  return {
    ...actual,
    useSession: () => mockUseSession() as { session: Session | null; loading: boolean; refetch: () => void },
  }
})

function renderHeader() {
  return render(
    <MemoryRouter>
      <AppHeader />
    </MemoryRouter>,
  )
}

const guest = { session: { authenticated: false } as Session, loading: false, refetch: vi.fn() }
const admin = {
  session: { authenticated: true, user: { id: 'u1', email: 'admin@example.com', role: 'admin' } } as Session,
  loading: false,
  refetch: vi.fn(),
}

beforeEach(() => {
  mockUseSession.mockReset()
})

describe('AppHeader', () => {
  it('links the brand home and the GitHub icon to the source repo', () => {
    mockUseSession.mockReturnValue(guest)
    renderHeader()
    expect(screen.getByRole('link', { name: 'Recall' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: /github/i })).toHaveAttribute(
      'href',
      'https://github.com/bffless/apps/tree/main/apps/recall',
    )
  })

  it('hides admin nav from guests and offers sign-in in the user menu', () => {
    mockUseSession.mockReturnValue(guest)
    renderHeader()
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /account/i }))
    expect(screen.getByText('Not signed in.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('shows admin nav and login details for an admin session', () => {
    mockUseSession.mockReturnValue(admin)
    renderHeader()
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
    expect(screen.getByRole('link', { name: 'Conversations' })).toHaveAttribute('href', '/admin/conversations')

    fireEvent.click(screen.getByRole('button', { name: /account/i }))
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
    expect(screen.getByText('Role: admin')).toBeInTheDocument()
  })
})
