import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import workflowSchema from '../src/schema/workflow-schema.js'

test('the generated (fs-free) schema module matches schema/workflow.schema.json', () => {
  const packaged = JSON.parse(
    readFileSync(new URL('../schema/workflow.schema.json', import.meta.url), 'utf8'),
  )
  expect(workflowSchema).toEqual(packaged)
})
