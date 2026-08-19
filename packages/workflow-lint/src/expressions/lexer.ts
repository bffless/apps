import { ExprSyntaxError, type Span } from './ast.js'

export type Token =
  | { kind: 'ident' | 'punct'; text: string; span: Span }
  | { kind: 'number'; value: number; span: Span }
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'eof'; span: Span }

// Longest first so '==' wins over '=' (which isn't a token at all) and '<=' over '<'.
const PUNCT = ['==', '!=', '<=', '>=', '&&', '||', '(', ')', '[', ']', '.', ',', '!', '<', '>']
const IDENT_START = /[A-Za-z_]/
const IDENT = /[A-Za-z0-9_-]/
const NUMBER = /^-?(0x[0-9a-fA-F]+|[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?)/

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'") {
      // single-quoted string; '' escapes a literal quote
      let j = i + 1
      let val = ''
      for (;;) {
        if (j >= src.length) throw new ExprSyntaxError('unterminated string', i)
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            val += "'"
            j += 2
          } else {
            j++
            break
          }
        } else {
          val += src[j]!
          j++
        }
      }
      out.push({ kind: 'string', value: val, span: { start: i, end: j } })
      i = j
      continue
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = NUMBER.exec(src.slice(i))!
      out.push({ kind: 'number', value: Number(m[0]), span: { start: i, end: i + m[0].length } })
      i += m[0].length
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < src.length && IDENT.test(src[j]!)) j++
      out.push({ kind: 'ident', text: src.slice(i, j), span: { start: i, end: j } })
      i = j
      continue
    }
    const p = PUNCT.find((p) => src.startsWith(p, i))
    if (p) {
      out.push({ kind: 'punct', text: p, span: { start: i, end: i + p.length } })
      i += p.length
      continue
    }
    throw new ExprSyntaxError(`unexpected character '${c}'`, i)
  }
  out.push({ kind: 'eof', span: { start: i, end: i } })
  return out
}
