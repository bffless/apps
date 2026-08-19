import { ExprSyntaxError, type Expr } from './ast.js'
import { parseExpression } from './parser.js'

export interface TemplateSpan {
  /** Expression source between the ${{ }} markers. */
  src: string
  /** Offset of the expression source within the scalar. */
  start: number
  end: number
  expr?: Expr
  error?: ExprSyntaxError
}

/**
 * Every `${{ … }}` occurrence in a scalar, parsed; never throws.
 * A `}` is not an expression token, so the first `}}` after `${{` always closes it.
 */
export function scanTemplates(value: string): TemplateSpan[] {
  const spans: TemplateSpan[] = []
  let i = 0
  for (;;) {
    const open = value.indexOf('${{', i)
    if (open === -1) break
    const start = open + 3
    const close = value.indexOf('}}', start)
    if (close === -1) {
      spans.push({
        src: value.slice(start),
        start,
        end: value.length,
        error: new ExprSyntaxError('unclosed ${{ — expected }}', start),
      })
      break
    }
    const src = value.slice(start, close)
    const span: TemplateSpan = { src, start, end: close }
    try {
      span.expr = parseExpression(src)
    } catch (err) {
      span.error = err instanceof ExprSyntaxError ? err : new ExprSyntaxError(String(err), start)
    }
    spans.push(span)
    i = close + 2
  }
  return spans
}

/** True when the scalar is exactly one expression (the value keeps its type). */
export function isSingleExpression(value: string): boolean {
  const t = value.trim()
  if (!t.startsWith('${{') || !t.endsWith('}}')) return false
  const spans = scanTemplates(t)
  return spans.length === 1 && spans[0]!.start === 3 && spans[0]!.end === t.length - 2
}

/**
 * `if:` values follow the GitHub rule: a string containing no ${{ at all is
 * parsed whole as one expression; otherwise it is a normal template.
 */
export function parseIfExpression(value: string): {
  expr?: Expr
  error?: ExprSyntaxError
  spans: TemplateSpan[]
} {
  if (!value.includes('${{')) {
    try {
      const expr = parseExpression(value)
      return { expr, spans: [{ src: value, start: 0, end: value.length, expr }] }
    } catch (err) {
      const error = err instanceof ExprSyntaxError ? err : new ExprSyntaxError(String(err), 0)
      return { error, spans: [{ src: value, start: 0, end: value.length, error }] }
    }
  }
  const spans = scanTemplates(value)
  const single = isSingleExpression(value) ? spans[0] : undefined
  return { expr: single?.expr, error: spans.find((s) => s.error)?.error, spans }
}
