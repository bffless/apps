import { parseDocument, LineCounter, isNode } from 'yaml'
import type { Finding } from '../findings.js'

export interface LoadedYaml {
  /** Plain JS value; may be partial or undefined when parsing failed. */
  data: unknown
  /** yaml-parse findings (empty for a clean document). */
  findings: Finding[]
  /** Resolve a JSON pointer to a 1-based source position. */
  locate(pointer: string): { line: number; col: number } | undefined
}

const FLOW_EXPR_HINT =
  'Inside a flow mapping/sequence ({ … } / [ … ]) an expression must be quoted — ' +
  'write body: { id: "${{ response.jobId }}" } — because ${{ opens a nested mapping. ' +
  'Block style needs no quotes.'

export function loadYaml(source: string): LoadedYaml {
  const lineCounter = new LineCounter()
  const doc = parseDocument(source, { lineCounter, uniqueKeys: true })
  const lines = source.split('\n')

  const findings: Finding[] = doc.errors.map((err) => {
    const [offset] = err.pos
    const { line, col } = lineCounter.linePos(offset)
    const lineText = lines[line - 1] ?? ''
    const hint = /[{[][^\n]*\$\{\{/.test(lineText) ? FLOW_EXPR_HINT : undefined
    return {
      rule: 'yaml-parse',
      severity: 'error',
      message: err.message.split('\n')[0] ?? err.message,
      path: '',
      pos: { line, col },
      hint,
    }
  })

  let data: unknown
  try {
    data = doc.toJS({ maxAliasCount: 100 })
  } catch {
    data = undefined
  }

  return {
    data,
    findings,
    locate(pointer) {
      if (pointer === '') return { line: 1, col: 1 }
      const segs = pointer
        .slice(1)
        .split('/')
        .map((s) => {
          const un = s.replaceAll('~1', '/').replaceAll('~0', '~')
          return /^\d+$/.test(un) ? Number(un) : un
        })
      const node = doc.getIn(segs, true)
      if (!isNode(node) || node.range == null) return undefined
      return lineCounter.linePos(node.range[0])
    },
  }
}
