import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { resetVideoBackendForTests } from '../../lib/videoBackend'
import { VideoBackendPicker } from './VideoBackendPicker'

// A fresh Response per call: setVideoBackend re-probes on every change (the
// memo is invalidated), and a Response body can only be read once — reusing
// one instance across calls (mockResolvedValue) makes the second probe's
// res.json() throw "Body is unusable", which the resolver swallows into a
// null-probe fallback and breaks the "switching persists" case below.
const probe = (caps: object) => vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(caps))))

beforeEach(() => {
  window.localStorage.clear()
  resetVideoBackendForTests()
})
afterEach(() => vi.unstubAllGlobals())

describe('VideoBackendPicker', () => {
  it('shows the active backend and disables executors the instance lacks', async () => {
    vi.stubGlobal('fetch', probe({ server: true, executors: ['local'], defaultExecutor: 'local' }))
    render(<VideoBackendPicker sceneCount={4} />)
    const select = (await screen.findByLabelText('Video backend')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('server'))
    expect((screen.getByRole('option', { name: 'Remote' }) as HTMLOptionElement).disabled).toBe(true)
    expect((screen.getByRole('option', { name: 'Local server' }) as HTMLOptionElement).disabled).toBe(false)
    expect(screen.getByTestId('video-backend-status').textContent).toMatch(/Server \(auto\) · local/)
  })

  it('remote shows the parallelism and switching persists', async () => {
    vi.stubGlobal('fetch', probe({ server: true, executors: ['local', 'remote'], defaultExecutor: 'local', remote: { ready: true } }))
    render(<VideoBackendPicker sceneCount={12} />)
    const select = (await screen.findByLabelText('Video backend')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('server'))
    fireEvent.change(select, { target: { value: 'remote' } })
    await waitFor(() => expect(select.value).toBe('remote'))
    expect(window.localStorage.getItem('videoBackend')).toBe('remote')
    expect(screen.getByTestId('video-backend-status').textContent).toMatch(/up to 8 parallel/)
  })

  it('surfaces the fallback note when a stored choice cannot be honoured', async () => {
    window.localStorage.setItem('videoBackend', 'remote')
    vi.stubGlobal('fetch', probe({ server: true, executors: ['local'], defaultExecutor: 'local' }))
    render(<VideoBackendPicker sceneCount={2} />)
    await screen.findByText(/Remote isn't enabled on this instance/)
    expect(((await screen.findByLabelText('Video backend')) as HTMLSelectElement).value).toBe('server')
  })

  it('offers only Browser when the instance has no server ops', async () => {
    vi.stubGlobal('fetch', probe({ server: false, ops: [], version: null }))
    render(<VideoBackendPicker sceneCount={2} />)
    const select = (await screen.findByLabelText('Video backend')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('wasm'))
    for (const name of ['Server (auto)', 'Local server', 'Remote'])
      expect((screen.getByRole('option', { name }) as HTMLOptionElement).disabled).toBe(true)
  })
})
