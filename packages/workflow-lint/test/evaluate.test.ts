import { test, expect } from 'vitest'
import { parseExpression } from '../src/expressions/parser.js'
import { evaluate, renderTemplate, EvalError } from '../src/expressions/evaluate.js'

const ev = (src: string, contexts: Record<string, unknown> = {}) =>
  evaluate(parseExpression(src), { contexts })

test('null propagation: missing property, null.x, out-of-range index', () => {
  expect(ev('a.b.c', { a: {} })).toBe(null)
  expect(ev('a.b.c', {})).toBe(null)
  expect(ev('a[5]', { a: [1] })).toBe(null)
  expect(ev('a[0].x', { a: [null] })).toBe(null)
})

test('dynamic index', () => {
  expect(ev('a[b]', { a: { k: 7 }, b: 'k' })).toBe(7)
  expect(ev('a[i]', { a: [10, 20], i: 1 })).toBe(20)
})

test('loose equality', () => {
  expect(ev("'ABC' == 'abc'")).toBe(true)
  expect(ev('null == 0')).toBe(true)
  expect(ev("'' == 0")).toBe(true)
  expect(ev('true == 1')).toBe(true)
  expect(ev("'2' == 2")).toBe(true)
  expect(ev('1 != 2')).toBe(true)
  expect(ev('null == null')).toBe(true)
})

test('relational: numeric coercion, NaN compares false', () => {
  expect(ev('2 < 10')).toBe(true)
  expect(ev("'2' < 10")).toBe(true)
  expect(ev("'abc' < 1")).toBe(false)
  expect(ev("'abc' >= 1")).toBe(false)
})

test('logical operators return operands and short-circuit', () => {
  expect(ev("x || 'fallback'", { x: null })).toBe('fallback')
  expect(ev("x || 'fallback'", { x: 'real' })).toBe('real')
  expect(ev('x && y', { x: 0, y: 'never' })).toBe(0)
  expect(ev('!x', { x: '' })).toBe(true)
})

test('length', () => {
  expect(ev('length(a)', { a: [1, 2, 3] })).toBe(3)
  expect(ev("length('abcd')")).toBe(4)
  expect(ev('length(null)')).toBe(0)
  expect(ev('length(a)', { a: { x: 1 } })).toBe(0)
})

test('pluck: flat and nested lists', () => {
  expect(ev("pluck(a, 'p')", { a: [{ p: 1 }, { p: 2 }] })).toEqual([1, 2])
  expect(ev("pluck(a, 'p')", { a: [[{ p: 1 }], [{ p: 2 }, { p: 3 }]] })).toEqual([[1], [2, 3]])
  expect(ev("pluck(a, 'p')", { a: [{ q: 1 }, 'x'] })).toEqual([null, null])
  expect(ev("pluck(a, 'p')", { a: 'not-a-list' })).toBe(null)
})

test('string functions are case-insensitive', () => {
  expect(ev("contains('Hello', 'ELL')")).toBe(true)
  expect(ev('contains(a, 2)', { a: [1, 2] })).toBe(true)
  expect(ev("contains(a, '2')", { a: [1, 2] })).toBe(true)
  expect(ev("startsWith('Hello', 'he')")).toBe(true)
  expect(ev("endsWith('Hello', 'LO')")).toBe(true)
})

test('format with escapes', () => {
  expect(ev("format('{0} and {1}', 'a', 'b')")).toBe('a and b')
  expect(ev("format('{{0}}')")).toBe('{0}')
})

test('join, toJSON, fromJSON', () => {
  expect(ev('join(a)', { a: [1, 2] })).toBe('1,2')
  expect(ev("join(a, ' - ')", { a: ['x', 'y'] })).toBe('x - y')
  expect(ev("fromJSON('[1,2]')[1]")).toBe(2)
  expect(ev('toJSON(a)', { a: { x: 1 } })).toBe('{\n  "x": 1\n}')
})

test('function name lookup is case-insensitive', () => {
  expect(ev("startswith('abc', 'a')")).toBe(true)
})

test('unknown function throws EvalError', () => {
  expect(() => ev('frobnicate(1)')).toThrow(EvalError)
})

test('status functions need a status provider', () => {
  expect(() => ev('success()')).toThrow(EvalError)
  const status = { success: () => true, failure: () => false, always: () => true, cancelled: () => false }
  expect(evaluate(parseExpression('success()'), { contexts: {}, status })).toBe(true)
  expect(evaluate(parseExpression('!failure()'), { contexts: {}, status })).toBe(true)
})

test('renderTemplate: single expression keeps type', () => {
  expect(renderTemplate('${{ inputs.names }}', { contexts: { inputs: { names: ['a'] } } })).toEqual(['a'])
  expect(renderTemplate('  ${{ n }}  ', { contexts: { n: 5 } })).toBe(5)
})

test('renderTemplate: interpolation stringifies', () => {
  expect(renderTemplate('hi ${{ x }}!', { contexts: { x: 5 } })).toBe('hi 5!')
  expect(renderTemplate('v=${{ x }}', { contexts: { x: null } })).toBe('v=')
  expect(renderTemplate('v=${{ x }}', { contexts: { x: [1, 2] } })).toBe('v=[1,2]')
  expect(renderTemplate('plain', { contexts: {} })).toBe('plain')
})
