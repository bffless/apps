// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { pipelineError, pipelineResult, structured } from './toolResults'

describe('structured', () => {
  it('wraps non-objects the way IslandHost does', () => {
    expect(structured({ a: 1 })).toEqual({ a: 1 })
    expect(structured('HI')).toEqual({ text: 'HI' })
    expect(structured([1, 2])).toEqual({ value: [1, 2] })
    expect(structured(3)).toEqual({ value: 3 })
    expect(structured(null)).toEqual({ value: null })
  })
})

describe('pipelineResult / pipelineError', () => {
  it('answers a 2xx as text + structuredContent', () => {
    expect(pipelineResult({ text: 'HI' })).toEqual({ content: [{ type: 'text', text: '{"text":"HI"}' }], structuredContent: { text: 'HI' } })
  })

  it('flattens a non-2xx into "<code>: <message>" with the status under _meta.bffless', () => {
    const r = pipelineError('/api/hello/fail', 500, { code: 'BOOM', message: 'it broke' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('BOOM: it broke')
    expect(r._meta).toEqual({ bffless: { status: 500 } })
    expect(pipelineError('/api/hello/x', 404, 'not found').content[0].text).toBe('HTTP_404: not found')
    expect(pipelineError('/api/hello/x', 502, null).content[0].text).toBe('HTTP_502: /api/hello/x failed with status 502')
  })
})
