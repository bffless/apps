/**
 * `line-viewer` — the `render: island` half of the M2 workflow (02/04).
 *
 * A viewer is opened by `IslandView` rather than by a step: the value arrives
 * as the tool input `{ value }`, and both host tools are refused, so this island
 * only ever reads. It is the same file format, the same sandbox and the same
 * bridge as `pick-line` — the difference is entirely in what it is allowed to do.
 */
import { App } from '@modelcontextprotocol/ext-apps'

const target = document.querySelector<HTMLPreElement>('[data-testid="viewer-value"]')!

const app = new App({ name: 'line-viewer', version: '1.0.0' })

app.ontoolinput = ({ arguments: args }) => {
  const { value } = (args ?? {}) as { value?: unknown }
  target.textContent = JSON.stringify(value ?? null, null, 2)
}

app.onteardown = async () => ({})

await app.connect()
