import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { recallApi } from './store/recallApi'
import App from './App'

// Home (Task 9) is RTK-backed (the search mutation), so App now needs a
// store in the tree the same way AdminVideos.test.tsx does.
function makeStore() {
  return configureStore({
    reducer: { [recallApi.reducerPath]: recallApi.reducer },
    middleware: (gdm) => gdm().concat(recallApi.middleware),
  })
}

describe('App', () => {
  it('renders the Recall home page', () => {
    render(
      <Provider store={makeStore()}>
        <MemoryRouter>
          <App />
        </MemoryRouter>
      </Provider>,
    )
    expect(screen.getByRole('heading', { name: 'Recall' })).toBeInTheDocument()
    expect(screen.getByLabelText('Search video transcripts')).toBeInTheDocument()
  })
})
