/**
 * CE's `function_handler` sandbox, rebuilt for tests — the context
 * `function-runner.service.ts` `run` builds, minus `utils` (nothing here signs
 * anything), so a committed `*.fn.js` bundle can be executed exactly as CE
 * executes it: no Node globals, no browser globals, one `data` in and one
 * `handler(data)` out.
 *
 * It lives here rather than in `bundle.test.ts` because more than one suite
 * needs it (`mcp/bundle.test.ts` smoke-runs every entry;
 * `mocks/runGate.fn.parity.test.ts` runs the run gate's bundle against the
 * mock's twin), and importing one *test* file from another registers its
 * `describe`s a second time — the whole freshness suite would run twice.
 *
 * Test-only tooling: nothing in the app or the mocks reaches for it.
 */
import vm from 'node:vm'

/** The sandbox CE builds (function-runner.service.ts `run`). */
export function ceSandbox(data: unknown): vm.Context {
  const logs: string[] = []
  const log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  return vm.createContext({
    data,
    Math,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    BigInt,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,
    console: { log, warn: log, error: log },
    __result__: undefined,
  })
}

/** Run a bundle the way CE does and return `handler(data)`'s settled value. */
export async function runInCeSandbox(code: string, data: unknown): Promise<unknown> {
  const sandbox = ceSandbox(data)
  const wrapped = `(async function () { ${code}\n if (typeof handler !== 'function') throw new Error('no handler'); __result__ = await handler(data) })()`
  await new vm.Script(wrapped, { filename: 'user-function.js' }).runInContext(sandbox, { timeout: 5000 })
  return sandbox.__result__
}
