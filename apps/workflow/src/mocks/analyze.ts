/**
 * The `hello/analyze` pipeline's computation — shared between the mock (this
 * file, imported directly) and the real rule (`analyze.fn.js`, a standalone
 * `function_handler` that cannot import, so it duplicates this logic; the two
 * are kept in sync by `analyze.fn.parity.test.ts`).
 */

export interface AnalyzeWord {
  text: string
  start: number
  end: number
}

export interface AnalyzeResult {
  words: AnalyzeWord[]
  counts: {
    columns: [{ key: 'line' }, { key: 'chars'; type: 'number' }]
    rows: { line: string; chars: number }[]
  }
  snippet: string
  longest: string
}

const round1 = (n: number): number => Math.round(n * 10) / 10

export function analyzeLines(input: unknown): AnalyzeResult {
  const lines = Array.isArray(input) ? input.map(String) : []

  const words: AnalyzeWord[] = []
  let i = 0
  for (const line of lines) {
    for (const text of line.split(/\s+/).filter(Boolean)) {
      const start = round1(i * 0.4)
      const end = round1(start + 0.4)
      words.push({ text, start, end })
      i += 1
    }
  }

  const counts = {
    columns: [{ key: 'line' }, { key: 'chars', type: 'number' }] as AnalyzeResult['counts']['columns'],
    rows: lines.map((line) => ({ line, chars: line.length })),
  }

  const snippet = 'export const lines = ' + JSON.stringify(lines)

  let longest = ''
  for (const line of lines) {
    if (line.length > longest.length) longest = line
  }

  return { words, counts, snippet, longest }
}
