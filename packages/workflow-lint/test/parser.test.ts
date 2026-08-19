import { test, expect } from 'vitest'
import { parseExpression } from '../src/expressions/parser.js'

test('member chains', () => {
  const e = parseExpression('steps.audio.outputs.wav') as any
  expect(e.kind).toBe('member')
  expect(e.property).toBe('wav')
  expect(e.object.property).toBe('outputs')
  expect(e.object.object.object).toMatchObject({ kind: 'ident', name: 'steps' })
})

test('dynamic and literal index', () => {
  const e = parseExpression("steps[matrix.video].outputs['wav']") as any
  expect(e.kind).toBe('index')
  expect(e.index).toMatchObject({ kind: 'string', value: 'wav' })
  expect(e.object.kind).toBe('member')
  expect(e.object.object.kind).toBe('index')
  expect(e.object.object.index.kind).toBe('member')
})

test("precedence: a || b && !c == 'd'", () => {
  const e = parseExpression("a || b && !c == 'd'") as any
  expect(e.op).toBe('||')
  expect(e.right.op).toBe('&&')
  expect(e.right.right.op).toBe('==')
  expect(e.right.right.left.kind).toBe('not')
})

test('relational binds tighter than equality', () => {
  const e = parseExpression('a == b < c') as any
  expect(e.op).toBe('==')
  expect(e.right.op).toBe('<')
})

test('parentheses override precedence', () => {
  const e = parseExpression('(a || b) && c') as any
  expect(e.op).toBe('&&')
  expect(e.left.op).toBe('||')
})

test('call with args', () => {
  const e = parseExpression("pluck(needs.per-video.outputs.sheets, 'path')") as any
  expect(e).toMatchObject({ kind: 'call', callee: 'pluck' })
  expect(e.args).toHaveLength(2)
})

test('call with no args', () => {
  expect(parseExpression('success()')).toMatchObject({ kind: 'call', callee: 'success', args: [] })
})

test('literals', () => {
  expect(parseExpression('null').kind).toBe('null')
  expect(parseExpression('true').kind).toBe('true')
  expect(parseExpression('false').kind).toBe('false')
  expect(parseExpression("'hi'")).toMatchObject({ kind: 'string', value: 'hi' })
  expect(parseExpression('1.5')).toMatchObject({ kind: 'number', value: 1.5 })
})

test('errors: trailing garbage, empty, dangling operator', () => {
  expect(() => parseExpression('a ||')).toThrow()
  expect(() => parseExpression('')).toThrow()
  expect(() => parseExpression('a b')).toThrow()
  expect(() => parseExpression('a.')).toThrow()
  expect(() => parseExpression('f(a,)')).toThrow()
  expect(() => parseExpression('(a')).toThrow()
})
