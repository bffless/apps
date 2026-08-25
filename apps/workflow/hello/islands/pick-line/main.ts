/**
 * `pick-line` — the M2 test implementation's interactive island (04).
 *
 * It is deliberately plain DOM: an island is a *bundle file*, not part of the
 * harness, and the point of this one is to prove the host's whole surface with
 * nothing else in the way —
 *
 * - `ui/notifications/tool-input` delivers the step's `with` minus
 *   `src`/`title`/`display`, so both `lines` and `words` must arrive;
 * - `tools/call` reaches the implementation's own pipelines (`echo`, shouted
 *   back through `structuredContent.text`) and the two host tools
 *   (`workflow.annotate`, `workflow.submit`);
 * - a rejected `workflow.submit` comes back as a tool *error*, not a throw, and
 *   the step stays `waiting` — so the island can show it and resubmit;
 * - a *transport* failure (the bridge gone, a request timed out) is a rejected
 *   promise, and every one of them lands in the visible error slot too — an
 *   island that swallows a rejection just stops responding, with nothing to
 *   tell the member why.
 *
 * Handlers are registered before `connect()` (the SDK warns otherwise: the host
 * may already have sent `tool-input` by the time a late handler is installed),
 * and `onteardown` is answered so the host's `ui/resource-teardown` is not a
 * method-not-found round trip on every completed step.
 */
import { App } from '@modelcontextprotocol/ext-apps'

interface ToolResultish {
  isError?: boolean
  content?: { type: string; text?: string }[]
  structuredContent?: Record<string, unknown>
}

const el = <T extends HTMLElement>(testid: string): T =>
  document.querySelector<T>(`[data-testid="${testid}"]`)!

const words = el('words')
const lines = el('lines')
const shouted = el('shouted')
const submitError = el('submit-error')

/** The text blocks of a tool result, joined — how the host reports an error (04). */
function resultText(result: ToolResultish): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** What a rejected `callServerTool` (not a tool error — a throw) reads as. */
const failureText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Run one host round trip and route *every* failure — a tool `isError` or a
 * rejected promise — into the error slot, so a click never dies silently.
 */
function attempt(work: () => Promise<void>): void {
  work().catch((error: unknown) => {
    submitError.textContent = failureText(error)
  })
}

const app = new App({ name: 'pick-line', version: '1.0.0' })

let picked: { line: string; index: number } | null = null

app.ontoolinput = ({ arguments: args }) => {
  const input = (args ?? {}) as { lines?: unknown; words?: unknown }
  const list = Array.isArray(input.lines) ? input.lines.map(String) : []
  const wordCount = Array.isArray(input.words) ? input.words.length : 0

  // Proves the *second* `with` key arrived: the island is opened with the whole
  // evaluated `with`, not just the one value it renders buttons from.
  words.textContent = `${list.length} lines · ${wordCount} words`

  lines.replaceChildren(
    ...list.map((line, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.testid = 'line'
      button.dataset.index = String(index)
      button.setAttribute('aria-pressed', 'false')
      button.textContent = line
      button.addEventListener('click', () => attempt(() => preview(line, index, button)))
      return button
    }),
  )
}

/** A line was clicked: shout it through the `echo` pipeline, then annotate the step. */
async function preview(line: string, index: number, button: HTMLButtonElement): Promise<void> {
  picked = { line, index }
  for (const other of lines.querySelectorAll('button')) {
    other.setAttribute('aria-pressed', String(other === button))
  }

  const echoed: ToolResultish = await app.callServerTool({
    name: 'echo',
    arguments: { text: line, upper: true },
  })
  if (echoed.isError) {
    shouted.textContent = ''
    submitError.textContent = resultText(echoed)
    return
  }
  submitError.textContent = ''
  shouted.textContent = String(echoed.structuredContent?.text ?? '')

  // Decision 12: a live annotation becomes a persisted `step.annotated` event.
  // The host refuses it as a tool error when the step is not the live one or
  // the annotation budget is spent (#370) — shown, like a refused submit.
  const annotated: ToolResultish = await app.callServerTool({
    name: 'workflow.annotate',
    arguments: { annotations: [{ level: 'notice', message: `Previewed ${line}` }] },
  })
  if (annotated.isError) submitError.textContent = resultText(annotated)
}

/**
 * `workflow.submit`. A rejected submit (nothing picked, or the deliberate
 * "Submit nothing") answers `isError` with the per-output messages the step's
 * declared `outputs` produced, and the step stays `waiting`.
 */
async function submit(outputs: Record<string, unknown>): Promise<void> {
  const result: ToolResultish = await app.callServerTool({
    name: 'workflow.submit',
    arguments: { outputs },
  })
  submitError.textContent = result.isError ? resultText(result) : ''
}

el<HTMLButtonElement>('submit').addEventListener('click', () => {
  attempt(() => submit(picked ? { line: picked.line, index: picked.index } : {}))
})

el<HTMLButtonElement>('submit-nothing').addEventListener('click', () => {
  attempt(() => submit({}))
})

app.onteardown = async () => ({})

await app.connect()
