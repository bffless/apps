/**
 * The one `mapping` reader both `render: chart` and `render: code` go through
 * (apps#380) — every non-object it can be handed, since a mapping comes out of
 * a workflow definition's YAML and is `unknown` by the time a renderer sees it.
 */
import { describe, expect, it } from 'vitest'
import { chartMapping, codeLanguage } from './mapping'

describe('chartMapping', () => {
  it('reads x/y and defaults kind to line', () => {
    expect(chartMapping({ x: 'line', y: 'chars' })).toEqual({ x: 'line', y: 'chars', kind: 'line' })
  })

  it('keeps kind: bar, and treats any other kind as a line', () => {
    expect(chartMapping({ x: 'a', y: 'b', kind: 'bar' })?.kind).toBe('bar')
    expect(chartMapping({ x: 'a', y: 'b', kind: 'pie' })?.kind).toBe('line')
  })

  it.each([undefined, null, 'nope', 42, [], { x: 'a' }, { y: 'b' }, { x: 1, y: 2 }])(
    'answers null for %p',
    (mapping) => {
      expect(chartMapping(mapping)).toBeNull()
    },
  )
})

describe('codeLanguage', () => {
  it('reads a string language', () => {
    expect(codeLanguage({ language: 'javascript' })).toBe('javascript')
  })

  it.each([undefined, null, 'javascript', 42, {}, { language: 7 }])(
    'answers undefined for %p',
    (mapping) => {
      expect(codeLanguage(mapping)).toBeUndefined()
    },
  )
})
