/**
 * M1 minor (Task 22): the harness kept its own copy of `collectRefs`/`Ref` —
 * this pins the `./expressions` subpath as the one place it comes from now.
 * `TypeEnv` stays internal; only `collectRefs`/`Ref`/`CallSite` cross the barrier.
 */
import { test, expect } from 'vitest'
import { collectRefs, parseExpression } from '../src/expressions/index.js'

test('the ./expressions barrel re-exports collectRefs', () => {
  const expr = parseExpression('steps.say.outputs.line')
  expect(collectRefs(expr)).toEqual({
    refs: [{ root: 'steps', path: ['say', 'outputs', 'line'], node: expr }],
    calls: [],
  })
})
