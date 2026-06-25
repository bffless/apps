import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { PersistGate } from 'redux-persist/integration/react'
import { BffStateProvider } from '@bffless/use-bff-state'
import './index.css'
import App from './App.tsx'
import { store, persistor } from './store'
import { MOCKS_ENABLED } from './mocks/config'

async function enableMocks() {
  if (!import.meta.env.DEV) return
  if (!MOCKS_ENABLED) {
    // Master switch off: make sure a worker a previous (mocks-on) session
    // registered isn't left intercepting — otherwise it keeps producing the
    // double Network rows and passthroughs even though we never start it now.
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

enableMocks().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Provider store={store}>
        <PersistGate loading={null} persistor={persistor}>
          <BffStateProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </BffStateProvider>
        </PersistGate>
      </Provider>
    </StrictMode>,
  )
})
