import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { BrowserSupportBanner } from './BrowserSupportBanner'
import { resetVideoBackendForTests, setVideoBackend } from '../lib/videoBackend'

const FIREFOX_UA =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function stubUserAgent(ua: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua)
}
/** A probe stub minting a fresh Response per call (a Response body reads once). */
function stubProbe(caps: object | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () =>
      caps === null ? new Response('nope', { status: 401 }) : new Response(JSON.stringify(caps)),
    ),
  )
}
const NO_SERVER = { server: false, ops: [], version: null }
const REMOTE = { server: true, executors: ['remote'], defaultExecutor: 'remote', remote: { ready: true } }

const mount = () =>
  render(
    <MemoryRouter>
      <BrowserSupportBanner />
    </MemoryRouter>,
  )

beforeEach(() => {
  window.localStorage.clear()
  resetVideoBackendForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('BrowserSupportBanner', () => {
  it('shows the warning in non-Firefox browsers when video ops run in the browser (wasm)', async () => {
    stubUserAgent(CHROME_UA)
    stubProbe(NO_SERVER)
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent(/firefox/i)
  })

  it('renders nothing in Firefox', async () => {
    stubUserAgent(FIREFOX_UA)
    stubProbe(NO_SERVER)
    mount()
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('renders nothing when the resolved backend is server-side (ffmpeg never runs in the tab)', async () => {
    stubUserAgent(CHROME_UA)
    stubProbe(REMOTE)
    mount()
    // Give the async resolution a tick, then assert it stayed hidden.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('appears when the user switches the picker to Browser, and hides when they switch back', async () => {
    stubUserAgent(CHROME_UA)
    stubProbe(REMOTE)
    mount()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    setVideoBackend('wasm')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    setVideoBackend('remote')
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('can be dismissed', async () => {
    stubUserAgent(CHROME_UA)
    stubProbe(NO_SERVER)
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
