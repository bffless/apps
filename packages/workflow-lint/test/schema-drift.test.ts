import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'

const here = new URL('.', import.meta.url)

test('packaged schema is byte-identical to the spec schema', () => {
  const packaged = readFileSync(new URL('../schema/workflow.schema.json', here), 'utf8')
  const spec = readFileSync(
    new URL('../../../apps/workflow/docs/spec/workflow.schema.json', here),
    'utf8',
  )
  expect(packaged).toBe(spec)
})
