/**
 * TEST-ONLY. A `ScriptContext` stand-in for the `scripts/*.test.ts` suites — the
 * same shape `apps/workflow/src/hello-scripts.test.ts` builds by hand, factored
 * out because six suites need it. Never imported by a script module, so it is
 * never bundled into a `dist/scripts/*.js` entry (Task 24 builds only the six
 * named entries under `scripts/`; `scripts/lib/` is support code).
 *
 * `annotations` and `logs` are captured so a suite can assert on the warning a
 * script raises (a script's only channel back to the step card besides its
 * outputs).
 */
import type { ScriptContext } from '@bffless/workflow-script'

export type Annotation = Parameters<ScriptContext['annotate']>[0]

export type FakeCtx = {
  ctx: ScriptContext
  logs: string[]
  annotations: Annotation[]
  abort: () => void
}

export function fakeCtx(
  inputs: Record<string, unknown>,
  fetchImpl: ScriptContext['files']['fetch'] = async () => new Response(null, { status: 404 }),
): FakeCtx {
  const logs: string[] = []
  const annotations: Annotation[] = []
  const controller = new AbortController()
  return {
    logs,
    annotations,
    abort: () => controller.abort(),
    ctx: {
      inputs,
      files: { fetch: fetchImpl },
      log: (msg: string) => logs.push(msg),
      annotate: (a: Annotation) => annotations.push(a),
      signal: controller.signal,
    },
  }
}
