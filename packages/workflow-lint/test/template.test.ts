import { test, expect } from 'vitest'
import { scanTemplates, isSingleExpression, parseIfExpression } from '../src/expressions/template.js'

test('finds all spans with offsets', () => {
  const spans = scanTemplates('a ${{ x }} b ${{ y.z }}')
  expect(spans).toHaveLength(2)
  expect(spans[0]!.src).toBe(' x ')
  expect(spans[0]!.start).toBe(5)
  expect(spans[1]!.start).toBe(16)
  expect(spans[0]!.expr).toBeDefined()
  expect(spans[1]!.expr).toBeDefined()
})

test('no expressions → empty', () => {
  expect(scanTemplates('plain text')).toEqual([])
})

test('parse error captured, not thrown', () => {
  const spans = scanTemplates('${{ a || }}')
  expect(spans[0]!.error).toBeDefined()
  expect(spans[0]!.expr).toBeUndefined()
})

test('unclosed ${{ is an error span', () => {
  const spans = scanTemplates('${{ a')
  expect(spans).toHaveLength(1)
  expect(spans[0]!.error).toBeDefined()
})

test('single expression detection', () => {
  expect(isSingleExpression('${{ inputs.names }}')).toBe(true)
  expect(isSingleExpression('  ${{ inputs.names }}  ')).toBe(true)
  expect(isSingleExpression('hi ${{ x }}')).toBe(false)
  expect(isSingleExpression('${{ x }}${{ y }}')).toBe(false)
  expect(isSingleExpression('plain')).toBe(false)
})

test('bare if expression parses whole string', () => {
  const r = parseIfExpression("steps.boom.outcome == 'failure'")
  expect(r.expr).toBeDefined()
  expect(r.spans).toHaveLength(1)
})

test('wrapped if expression uses template scan', () => {
  const r = parseIfExpression('${{ inputs.write_blog }}')
  expect(r.spans).toHaveLength(1)
  expect(r.spans[0]!.expr).toBeDefined()
})

test('bare if with syntax error captured', () => {
  const r = parseIfExpression('a &&')
  expect(r.error).toBeDefined()
})
