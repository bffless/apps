import { describe, expect, it } from 'vitest'
import { errorResult, isErrorResult, textResult } from '../src/results.js'

describe('CallToolResult builders', () => {
  it('textResult carries prose and the structured half', () => {
    expect(textResult('Started run_1', { runId: 'run_1' })).toEqual({
      content: [{ type: 'text', text: 'Started run_1' }],
      structuredContent: { runId: 'run_1' },
    })
  })

  it('textResult without structured content has no structuredContent key at all', () => {
    const result = textResult('nothing to add')
    expect(result).toEqual({ content: [{ type: 'text', text: 'nothing to add' }] })
    expect('structuredContent' in result).toBe(false)
    expect(isErrorResult(result)).toBe(false)
  })

  it('errorResult is isError with a 07-keyed errors map, plus whatever rides along', () => {
    const result = errorResult('These inputs cannot start a run', {
      errors: { greeting: 'This field is required' },
      timedOut: true,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'These inputs cannot start a run' })
    expect(result.structuredContent).toEqual({ errors: { greeting: 'This field is required' }, timedOut: true })
    expect(isErrorResult(result)).toBe(true)
  })
})
