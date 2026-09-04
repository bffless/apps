/**
 * The step view (spec 10 §Islands and the run view; Phase 2 plan, Decision 3):
 * the engine-less host page an agent host mounts for `workflow.submitStep`.
 *
 * Outward it is an MCP App: the host sends the tool call's arguments —
 * `{ runId, step }` — as `ui/notifications/tool-input`, and every capability
 * it needs is a `tools/call` the host proxies to the harness's own MCP
 * endpoint. Inward it is the harness's `IslandHost`: the waiting island is
 * fetched (through `workflow.stepView`) and mounted, unchanged, in the nested
 * `sandbox="allow-scripts"` srcdoc frame below, under the same bridge the
 * harness page gives it — the mechanism D24's run view will reuse.
 *
 * Handlers are registered before `connect()` (the host may send `tool-input`
 * the moment the handshake completes). There is no engine here: a submit
 * writes the step row; the run continues when it is resumed on the harness.
 */
import { App } from '@modelcontextprotocol/ext-apps'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { createIslandHost } from '../islands/IslandHost'
import { StepForm } from './StepForm'
import { readStepView, signFormPreviews, stepViewDeps, submitFormValues } from './deps'
import { trustSignedUrl } from '../lib/url'
import '../index.css'

const HOST_PROTOCOL_VERSION = '1.0.0'

const el = <T extends HTMLElement>(testid: string): T => document.querySelector<T>(`[data-testid="${testid}"]`)!

const title = el<HTMLHeadingElement>('title')
const status = el<HTMLSpanElement>('status')
const frame = el<HTMLIFrameElement>('island')
const submitted = el<HTMLParagraphElement>('submitted')
const formRoot = el<HTMLDivElement>('form')
let reactRoot: Root | null = null

function say(line: string, level: 'info' | 'error' = 'info'): void {
  status.textContent = line
  status.dataset.level = level
}

const app = new App({ name: 'bffless-workflow-step', version: HOST_PROTOCOL_VERSION })
const call = app.callServerTool.bind(app)

let mounting: AbortController | null = null

app.ontoolinput = ({ arguments: args }) => {
  const input = (args ?? {}) as { runId?: unknown; step?: unknown }
  const runId = typeof input.runId === 'string' ? input.runId : ''
  const step = typeof input.step === 'string' ? input.step : ''
  if (runId === '' || step === '') {
    say('workflow.submitStep needs a runId and a step to show an island', 'error')
    return
  }

  mounting?.abort()
  const controller = new AbortController()
  mounting = controller
  title.textContent = step
  say(`Loading ${step} of ${runId}…`)
  submitted.hidden = true

  void (async () => {
    try {
      const view = readStepView(await call({ name: 'workflow.stepView', arguments: { runId, step } }))
      if (controller.signal.aborted) return
      const finished = () => {
        submitted.textContent = `Submitted ${view.step}. Open run ${view.runId} on the harness and Resume to continue.`
        submitted.hidden = false
        say(`${view.step} submitted`)
      }
      if (view.kind === 'form') {
        title.textContent = `${view.workflow}: ${view.title}`
        frame.hidden = true
        formRoot.hidden = false
        const { view: signedView, signed } = await signFormPreviews(call, view)
        if (controller.signal.aborted) return
        for (const url of signed) trustSignedUrl(url)
        reactRoot ??= createRoot(formRoot)
        reactRoot.render(
          <StepForm
            key={`${view.runId}:${view.step}`}
            title={view.title}
            description={view.description}
            submitLabel={view.submit}
            fields={signedView.fields}
            initial={view.initial}
            onSubmit={async (values) => {
              const answer = await submitFormValues(call, view, values)
              if (answer.ok) finished()
              return answer
            }}
          />,
        )
        say(`${view.step} is waiting for you`)
        return
      }
      formRoot.hidden = true
      frame.hidden = false
      title.textContent = `${view.workflow}: ${view.step}`
      const host = createIslandHost(stepViewDeps(call, view, { onLog: (line) => say(line), onSubmitted: finished }))
      await host.mount(frame, { impl: view.impl, src: view.src, arguments: view.arguments, headless: false, signal: controller.signal })
      say(`${view.impl}/${view.src} is waiting for you`)
    } catch (error) {
      if (controller.signal.aborted) return
      say(error instanceof Error ? error.message : String(error), 'error')
    }
  })()
}

// The host sizes the frame by what the page asks for; the nested island's own
// size-changed already grows the inner frame, so the body's height is the ask.
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    void app.sendSizeChanged({ height: Math.ceil(document.body.scrollHeight) }).catch(() => undefined)
  }).observe(document.body)
}

app.onteardown = async () => {
  mounting?.abort()
  return {}
}

await app.connect()
say('Waiting for a step to show…')
