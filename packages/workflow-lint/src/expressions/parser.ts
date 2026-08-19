import { ExprSyntaxError, type BinOp, type Expr } from './ast.js'
import { tokenize, type Token } from './lexer.js'

export function parseExpression(src: string): Expr {
  const toks = tokenize(src)
  let pos = 0
  const peek = (): Token => toks[pos]!
  const next = (): Token => toks[pos++]!
  const isPunct = (text: string): boolean => {
    const t = peek()
    return t.kind === 'punct' && t.text === text
  }
  const expectPunct = (text: string): Token => {
    const t = next()
    if (t.kind !== 'punct' || t.text !== text) {
      throw new ExprSyntaxError(`expected '${text}'`, t.span.start)
    }
    return t
  }

  function binaryLevel(ops: BinOp[], operand: () => Expr): () => Expr {
    return () => {
      let left = operand()
      for (;;) {
        const t = peek()
        if (t.kind === 'punct' && (ops as string[]).includes(t.text)) {
          next()
          const right = operand()
          left = {
            kind: 'binary',
            op: t.text as BinOp,
            left,
            right,
            span: { start: left.span.start, end: right.span.end },
          }
        } else {
          return left
        }
      }
    }
  }

  function parseUnary(): Expr {
    if (isPunct('!')) {
      const t = next()
      const operand = parseUnary()
      return { kind: 'not', operand, span: { start: t.span.start, end: operand.span.end } }
    }
    return parsePostfix()
  }

  function parsePostfix(): Expr {
    let e = parsePrimary()
    for (;;) {
      if (isPunct('.')) {
        next()
        const t = next()
        if (t.kind !== 'ident') throw new ExprSyntaxError('expected property name', t.span.start)
        e = { kind: 'member', object: e, property: t.text, span: { start: e.span.start, end: t.span.end } }
      } else if (isPunct('[')) {
        next()
        const idx = parseOr()
        const close = expectPunct(']')
        e = { kind: 'index', object: e, index: idx, span: { start: e.span.start, end: close.span.end } }
      } else {
        return e
      }
    }
  }

  function parsePrimary(): Expr {
    const t = next()
    if (t.kind === 'number') return { kind: 'number', value: t.value, span: t.span }
    if (t.kind === 'string') return { kind: 'string', value: t.value, span: t.span }
    if (t.kind === 'punct' && t.text === '(') {
      const e = parseOr()
      expectPunct(')')
      return e
    }
    if (t.kind === 'ident') {
      if (t.text === 'null' || t.text === 'true' || t.text === 'false') {
        return { kind: t.text, span: t.span }
      }
      if (isPunct('(')) {
        next()
        const args: Expr[] = []
        if (!isPunct(')')) {
          args.push(parseOr())
          while (isPunct(',')) {
            next()
            args.push(parseOr())
          }
        }
        const close = expectPunct(')')
        return { kind: 'call', callee: t.text, args, span: { start: t.span.start, end: close.span.end } }
      }
      return { kind: 'ident', name: t.text, span: t.span }
    }
    throw new ExprSyntaxError('unexpected end of expression', t.span.start)
  }

  const parseRelational = binaryLevel(['<', '<=', '>', '>='], parseUnary)
  const parseEquality = binaryLevel(['==', '!='], parseRelational)
  const parseAnd = binaryLevel(['&&'], parseEquality)
  const parseOr = binaryLevel(['||'], parseAnd)

  const e = parseOr()
  const tail = peek()
  if (tail.kind !== 'eof') {
    throw new ExprSyntaxError('unexpected token after expression', tail.span.start)
  }
  return e
}
