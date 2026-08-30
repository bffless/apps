/**
 * An island's entry, shared: the MCP Apps handshake, and nothing else. Each island's
 * `main.tsx` imports its stylesheet, then hands this its name and its root component.
 *
 * Handlers are registered BEFORE `connect()` — the SDK warns otherwise, because the
 * host may already have sent `tool-input` by the time a late handler is installed —
 * and `onteardown` is answered so the host's `ui/resource-teardown` isn't a
 * method-not-found round trip on every completed step (`bffless/workflow-hello`'s
 * islands are the reference for both).
 *
 * No `StrictMode`: its deliberate double-invocation of effects would fire a headless
 * auto-submit twice, and the claim-once latch that guards a re-delivered `tool-input`
 * lives inside each island's component, not around it.
 */
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@modelcontextprotocol/ext-apps'

/**
 * How long the handshake gets before the shell declares "no workflow host". The timer
 * is OURS, not the SDK's: a host that attaches the island but never answers
 * `ui/initialize` leaves `connect()` sitting on the MCP SDK's default 60 s request
 * timeout — long after any screenshot — so 5 s (generous for a `postMessage` round
 * trip) settles the shell inside the smoke's 15 s `--wait` window (`scripts/shot.mjs`).
 * Note the documented standalone smoke does NOT reach this timer: a top-level window
 * posts `ui/initialize` to itself and the SDK answers its own request with "Method not
 * found", so standalone rejects promptly — the "rejected" branch below. (apps#523)
 */
const HANDSHAKE_TIMEOUT_MS = 5_000

export async function mountIsland(
  name: string,
  render: (args: Record<string, unknown>, bridge: App) => ReactNode,
): Promise<void> {
  const app = new App({ name, version: '1.0.0' })
  const root = createRoot(document.getElementById('root')!)

  app.ontoolinput = ({ arguments: args }) => {
    // The static shell in the island's `index.html` is what a member sees until the
    // step's `with` arrives (and all anyone sees if the file is opened outside the
    // harness).
    document.getElementById('island-waiting')?.remove()
    root.render(render((args ?? {}) as Record<string, unknown>, app))
  }

  app.onteardown = async () => ({})

  // A failed handshake is the one error nothing else can report: there is no bridge to
  // send it over and no component rendered yet. Unhandled it is an invisible page error —
  // the island just sits there saying "waiting" forever — so it goes in the shell
  // instead, and the shell records WHICH failure via `data-handshake-state`, because the
  // two failures behave differently: a host that answers but breaks the handshake
  // rejects promptly and carries a reason ("rejected"), while no host at all never
  // answers, so `connect()` is raced against `HANDSHAKE_TIMEOUT_MS` ("timeout" — see the
  // constant's comment for why the SDK's own timeout is useless here). First settled
  // outcome wins; the rejection handler stays attached either way, so the SDK's late
  // 60 s give-up never surfaces as an unhandled rejection. (`bffless/workflow-hello`'s
  // islands leave all of this unhandled.)
  await new Promise<void>((resolve) => {
    let settled = false
    const fail = (state: 'rejected' | 'timeout', message: string): void => {
      if (settled) return
      settled = true
      document.getElementById('island-waiting')?.setAttribute('data-handshake-state', state)
      const note = document.querySelector('.island-waiting-sub')
      if (note) note.textContent = message
      resolve()
    }
    const timer = setTimeout(() => fail('timeout', 'no workflow host'), HANDSHAKE_TIMEOUT_MS)
    app.connect().then(
      () => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        resolve()
      },
      (error: unknown) => {
        clearTimeout(timer)
        const detail = error instanceof Error ? error.message : String(error)
        fail('rejected', `bridge rejected: ${detail}`)
      },
    )
  })
}
