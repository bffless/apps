// @vitest-environment node
/**
 * Parity: the strings the bundle restates must be the page's own, byte for
 * byte (the fence keeps the bundle from importing the modules that own them).
 */
import { describe, expect, it } from 'vitest'
import { START_REFUSALS } from '../lib/autoStart'
import { workflowId as pageWorkflowId } from '../lib/coerce'
import { workflowId } from './ids'
import { REFUSALS } from './refusals'

describe('refusal strings', () => {
  it("are lib/autoStart's START_REFUSALS", () => {
    expect(REFUSALS).toEqual(START_REFUSALS)
  })
})

describe('workflowId', () => {
  it("is lib/coerce's workflowId", () => {
    for (const file of ['interactive.workflow.yaml', 'hello.yaml', 'long-to-short.workflow.yml', 'x.yml', 'plain']) {
      expect(workflowId(file), file).toBe(pageWorkflowId(file))
    }
  })
})
