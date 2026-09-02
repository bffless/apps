import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import { AgentTools } from './agent/AgentTools'
import App from './App'
import { installDiagnostics } from './lib/diagnostics'
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
          {/* The page's WebMCP tool surface (spec 10): once, beside the app, inside the router. */}
          <AgentTools />
        </BrowserRouter>
      </Provider>
    </StrictMode>,
  )
}

// Before anything can fail: the run page's Copy diagnostics / Attach to run
// (apps#526) reports whatever this buffer caught, and an error that fires
// before the capture is installed is exactly the kind that never reaches the
// run record.
installDiagnostics()

// `finally`, not `then`: a service worker that refuses to register (an
// unsupported browser, a hard-reload race, a stale worker file) is a reason to
// run against the real backend — never a reason to render nothing at all.
enableMocks()
  .catch((error) => console.error('[mocks] worker did not start', error))
  .finally(render)
