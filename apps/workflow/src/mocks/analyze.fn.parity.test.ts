/**
 * Parity between `analyze.fn.js` (the real rule's standalone `function_handler`
 * code — cannot import) and `analyze.ts` (the mock's shared helper). `new
 * Function` is test-only tooling to execute the authored `.fn.js` source in
 * isolation; it is never used by the app or the mock at runtime.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeLines } from './analyze'

const FN_PATH = join(
  __dirname,
  '..',
  '..',
  '.bffless',
  'proxy-rules',
  'hello',
  'rules',
  'api',
  'hello',
  'analyze',
  'post',
  'analyze.fn.js',
)

function loadFnHandler(): (ctx: { request: { body?: Record<string, unknown> } }) => unknown {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

describe('analyze.fn.js parity with the mock helper', () => {
  const handler = loadFnHandler()

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
