/**
 * The shared handshake (`mount.tsx`): which failure the waiting shell reports, and how.
 *
 * `mountIsland` races `connect()` against a 5 s timer and stamps the outcome on the
 * shell as `data-handshake-state` — `"rejected"` (a host answered but broke the
 * handshake, promptly and with a reason) or `"timeout"` (no host answered at all —
 * the standalone smoke's case, which otherwise sits on the MCP SDK's 60 s request
 * timeout). The suite proves both branches' copy + attribute, that the first settled
 * outcome wins (the SDK's late give-up neither rewrites the shell nor escapes as an
 * unhandled rejection — Vitest fails the run if it did), and that success stamps
 * nothing (shell removal belongs to `tool-input`, untouched here). (apps#523)
 *
 * ## Why a module mock, not `islands/test/fakeIsland.ts`
 *
 * The fake host fakes the BRIDGE (`IslandBridge`) — the surface an island's component
 * consumes AFTER a handshake. The subject here is the handshake itself, upstream of
 * any component, and the real `App.connect()` posts `ui/initialize` to `window.parent`
 * — which under jsdom is the test's own window, so nothing would ever answer. Same
 * rationale as `fakeIsland.ts`: the fake stops at the surface under test, and the
 * fidelity anchor is `mount.tsx` itself calling the real `App` in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountIsland } from './mount'

const { connectMock } = vi.hoisted(() => ({
  connectMock: vi.fn<() => Promise<void>>(),
}))

vi.mock('@modelcontextprotocol/ext-apps', () => ({
  // Only the surface `mountIsland` touches: the two handlers it assigns, and the
  // `connect()` each test scripts.
  App: class FakeApp {
    ontoolinput: ((input: { arguments?: Record<string, unknown> }) => void) | null = null
    onteardown: (() => Promise<Record<string, never>>) | null = null
    connect = connectMock
  },
}))

/** The static shell as both islands' `index.html` carry it, plus the mount point. */
const SHELL_HTML = `
  <div id="island-waiting" class="island-waiting">
    <p>Waiting for the workflow…</p>
    <p class="island-waiting-sub">This editor opens when the run reaches the trim step.</p>
  </div>
  <div id="root"></div>
`

const shell = (): HTMLElement => document.getElementById('island-waiting')!
const sub = (): Element => document.querySelector('.island-waiting-sub')!

beforeEach(() => {
  document.body.innerHTML = SHELL_HTML
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('mountIsland handshake', () => {
  it('a rejected handshake writes the reason and stamps "rejected"', async () => {
    connectMock.mockRejectedValueOnce(new Error('host refused ui/initialize'))

    await mountIsland('cut-editor', () => null)

    expect(sub()).toHaveTextContent('bridge rejected: host refused ui/initialize')
    expect(shell()).toHaveAttribute('data-handshake-state', 'rejected')
  })

  it('a connect() that never settles stamps "timeout" at 5 s, and a late rejection cannot overwrite it', async () => {
    vi.useFakeTimers()
    let giveUp!: (error: Error) => void
    connectMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          giveUp = reject
        }),
    )

    const mounted = mountIsland('cut-editor', () => null)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(shell()).not.toHaveAttribute('data-handshake-state')

    await vi.advanceTimersByTimeAsync(1)
    await mounted
    expect(sub()).toHaveTextContent('no workflow host')
    expect(shell()).toHaveAttribute('data-handshake-state', 'timeout')

    // The SDK's own 60 s give-up, arriving after the race is lost: the attached
    // handler absorbs it (an unhandled rejection would fail this run) and the shell
    // keeps the first settled outcome.
    giveUp(new Error('Request timed out'))
    await vi.advanceTimersByTimeAsync(0)
    expect(sub()).toHaveTextContent('no workflow host')
    expect(shell()).toHaveAttribute('data-handshake-state', 'timeout')
  })

  it('a successful handshake stamps nothing — the shell waits for tool-input', async () => {
    connectMock.mockResolvedValueOnce(undefined)

    await mountIsland('cut-editor', () => null)

    expect(shell()).not.toHaveAttribute('data-handshake-state')
    expect(sub()).toHaveTextContent('This editor opens when the run reaches the trim step.')
  })
})
