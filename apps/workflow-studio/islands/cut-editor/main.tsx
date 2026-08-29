/**
 * The `cut-editor` island's entry: the MCP Apps handshake, and nothing else.
 *
 * Handlers are registered BEFORE `connect()` — the SDK warns otherwise, because the
 * host may already have sent `tool-input` by the time a late handler is installed —
 * and `onteardown` is answered so the host's `ui/resource-teardown` isn't a
 * method-not-found round trip on every completed step (`bffless/workflow-hello`'s
 * islands are the reference for both).
 *
 * No `StrictMode`: its deliberate double-invocation of effects would fire the headless
 * auto-submit twice, and the claim-once latch that guards a re-delivered `tool-input`
 * lives inside the component, not around it.
 */
import './styles.css'
import { createRoot } from 'react-dom/client'
import { App } from '@modelcontextprotocol/ext-apps'
import { Editor } from './App'

const app = new App({ name: 'cut-editor', version: '1.0.0' })
const root = createRoot(document.getElementById('root')!)

app.ontoolinput = ({ arguments: args }) => {
  // The static shell in `index.html` is what a member sees until the step's `with`
  // arrives (and all anyone sees if this file is opened outside the harness).
  document.getElementById('island-waiting')?.remove()
  root.render(<Editor args={(args ?? {}) as Record<string, unknown>} bridge={app} />)
}

app.onteardown = async () => ({})

// A failed handshake is the one error nothing else can report: there is no bridge to
// send it over and no editor rendered yet. Unhandled it is an invisible page error —
// the island just sits there saying "waiting" forever — so it goes in the shell
// instead. (`bffless/workflow-hello`'s islands leave this rejection unhandled; opening
// a built island outside the harness, which is how the build is smoke-checked, is
// exactly the case that produces it.)
await app.connect().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error)
  const note = document.querySelector('.island-waiting-sub')
  if (note) note.textContent = `No workflow on the other end — ${detail}`
})
