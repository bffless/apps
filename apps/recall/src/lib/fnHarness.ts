/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real fn contract (confirmed against apps/recall's own transcribe/* fns and
// Studio's originals, and against CE's function_handler runtime —
// repos/ce/apps/backend/src/pipelines/handlers/function.handler.ts +
// function-runner.service.ts): a pipeline `*.fn.js` file declares
//   function handler({ user, request, steps, deployment, utils }) { ...; return {...} }
// and the runtime evaluates the source, then calls `handler(ctx)` and uses
// the return value directly as the step's output. There is no `var output`
// convention — that was the brief's untested assumption; the CE runtime
// literally does `__result__ = await handler(data)`.

const RULES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../.bffless/proxy-rules/recall/rules',
)

/**
 * Reads a pipeline fn.js source file by its path relative to the rule set's
 * `rules/` root, e.g. `loadFnSource('api/index/post/chunk.fn.js')`.
 */
export function loadFnSource(relPath: string): string {
  return readFileSync(join(RULES_ROOT, relPath), 'utf-8')
}

/**
 * Runs a pipeline fn.js source the way CE's function_handler runs it in
 * production: evaluate the source (which declares `handler`), then call
 * `handler(ctx)` and return its result.
 */
export function runFn(src: string, ctx: Record<string, unknown> = {}): unknown {
  const load = new Function(
    `${src}\nreturn typeof handler === 'function' ? handler : undefined;`,
  ) as () => ((ctx: Record<string, unknown>) => unknown) | undefined
  const handler = load()
  if (typeof handler !== 'function') {
    throw new Error('fn source did not define a handler(...) function')
  }
  return handler(ctx)
}
