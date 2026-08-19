import { test, expect } from 'vitest'
import { tokenize } from '../src/expressions/lexer.js'
import { ExprSyntaxError } from '../src/expressions/ast.js'

const flat = (s: string) =>
  tokenize(s).map((t) =>
    t.kind === 'eof' ? '<eof>' : t.kind === 'number' || t.kind === 'string' ? t.value : t.text,
  )

test('identifiers keep dashes and underscores', () => {
  expect(flat('needs.per-video.outputs')).toEqual(['needs', '.', 'per-video', '.', 'outputs', '<eof>'])
  expect(flat('strategy.job-index')).toEqual(['strategy', '.', 'job-index', '<eof>'])
  expect(flat('inputs.write_blog')).toEqual(['inputs', '.', 'write_blog', '<eof>'])
})

test('strings use double-single-quote escape', () => {
  expect(tokenize("'it''s'")[0]).toMatchObject({ kind: 'string', value: "it's" })
  expect(tokenize("''")[0]).toMatchObject({ kind: 'string', value: '' })
})

test('numbers: ints, floats, exponents, hex, negatives', () => {
  expect(flat('42')).toEqual([42, '<eof>'])
  expect(flat('-3.5e2')).toEqual([-350, '<eof>'])
  expect(flat('0xff')).toEqual([255, '<eof>'])
})

test('operators and punctuation', () => {
  expect(flat("a == 'b' && !c || d <= 1")).toEqual(['a', '==', 'b', '&&', '!', 'c', '||', 'd', '<=', 1, '<eof>'])
  expect(flat('f(x, y[0])')).toEqual(['f', '(', 'x', ',', 'y', '[', 0, ']', ')', '<eof>'])
  expect(flat('a != b >= c')).toEqual(['a', '!=', 'b', '>=', 'c', '<eof>'])
})

test('spans record offsets', () => {
  const toks = tokenize('ab  ==')
  expect(toks[0]!.span).toEqual({ start: 0, end: 2 })
  expect(toks[1]!.span).toEqual({ start: 4, end: 6 })
})

test('unterminated string throws with offset', () => {
  expect(() => tokenize("'abc")).toThrow(ExprSyntaxError)
})

test('unexpected character throws', () => {
  expect(() => tokenize('a # b')).toThrow(ExprSyntaxError)
})
