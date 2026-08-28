/**
 * Parity between `analyze.fn.js` (the real rule's standalone `function_handler`
 * code — cannot import) and `analyze.ts` (the mock's shared helper). `new
 * Function` is test-only tooling to execute the authored `.fn.js` source in
 * isolation; it is never used by the app or the mock at runtime.
 *
 * The rule now lives in `bffless/workflow-hello` (M3 Task 7), so this reads it
 * out of `hello-src/` — populated by `pnpm --filter workflow stage` (a network
 * clone) — and skips cleanly when unstaged, the same way `hello-scripts.test.ts`
 * does.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeLines } from './analyze'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(appDir, 'hello-src', '.bffless', 'proxy-rules', 'hello', 'rules', 'analyze', 'post', 'analyze.fn.js')

function loadFnHandler(): (ctx: { request: { body?: Record<string, unknown> } }) => unknown {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

describe.skipIf(!existsSync(FN_PATH))('analyze.fn.js parity with the mock helper', () => {
  // Not a module-scope `const`: vitest still calls a `describe.skipIf` body to
  // *collect* the tests inside even when every one of them ends up skipped, so
  // loading the fixture file here would still throw on an unstaged checkout.
  let handler: (ctx: { request: { body?: Record<string, unknown> } }) => unknown

  beforeAll(() => {
    handler = loadFnHandler()
  })

  const cases: unknown[] = [
    ['Hello, world!'],
    ['Hello, world!', 'Second   line  here'],
    [],
    [''],
    ['   '],
    'not-an-array',
    undefined,
  ]

  it.each(cases)('matches analyzeLines() for lines=%j', (lines) => {
    const fromFn = handler({ request: { body: { lines } } })
    const fromTs = analyzeLines(lines)
    expect(fromFn).toEqual(fromTs)
  })

  // A hand-rolled POST with no body reaches the handler with `request.body`
  // undefined; that is an empty analysis, not a throw inside the pipeline.
  it('treats a bodyless request as no lines', () => {
    expect(handler({ request: {} })).toEqual(analyzeLines(undefined))
  })
})
