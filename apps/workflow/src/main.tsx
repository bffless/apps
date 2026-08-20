import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { MOCKS_ENABLED } from './mocks/config'
import { store } from './store'
import './index.css'

async function enableMocks() {
  if (!import.meta.env.DEV) return
  if (!MOCKS_ENABLED) {
    // Master switch off: make sure a worker a previous (mocks-on) session
    // registered isn't left intercepting — otherwise it keeps answering from the
    // mock backend even though we never start it now.
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? []
    await Promise.all(
      regs
        .filter((r) => r.active?.scriptURL.includes('mockServiceWorker'))
        .map((r) => r.unregister()),
    )
    return
  }
  const { worker } = await import('./mocks/browser')
  await worker.start({ onUnhandledRequest: 'bypass' })
}

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Provider>
    </StrictMode>,
  )
}

// `finally`, not `then`: a service worker that refuses to register (an
// unsupported browser, a hard-reload race, a stale worker file) is a reason to
// run against the real backend — never a reason to render nothing at all.
enableMocks()
  .catch((error) => console.error('[mocks] worker did not start', error))
  .finally(render)
