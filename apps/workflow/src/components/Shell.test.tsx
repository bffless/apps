/**
 * The shell header's user chip (08: "the header shows the user").
 *
 * M1 had nothing to show — the harness had no current-user endpoint (R8).
 * Task 19's `whoami` rule is it, and this is the one place the whole app says
 * who you are, which is also what makes Delete's owner gate legible.
 */
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { MOCK_ADMIN, setMockUser } from '../mocks/db'
import { server } from '../mocks/server'
import { makeStore } from '../store'

function renderApp(path = '/') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('Shell — the session user', () => {
  it("shows the signed-in user's email", async () => {
    renderApp()

    expect(await screen.findByTestId('whoami')).toHaveTextContent('workflow-ci@example.test')
  })

  it('shows whoever the session actually is', async () => {
    setMockUser(MOCK_ADMIN)
    renderApp()

    expect(await screen.findByTestId('whoami')).toHaveTextContent(MOCK_ADMIN.email)
  })

  it('falls back to the id when the session has no email', async () => {
    server.use(
      http.get('/api/workflow/whoami', () =>
        HttpResponse.json({ id: 'user_key', email: '', role: '' }),
      ),
    )
    renderApp()

    expect(await screen.findByTestId('whoami')).toHaveTextContent('user_key')
  })

  it('shows nothing at all when the user cannot be read', async () => {
    server.use(
      http.get('/api/workflow/whoami', () => new HttpResponse(null, { status: 500 })),
    )
    renderApp()

    // The rail settles, so the header has had its chance to render a chip.
    await screen.findByRole('navigation', { name: 'Implementations' })
    expect(screen.queryByTestId('whoami')).not.toBeInTheDocument()
  })
})
