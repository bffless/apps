// Mirrors src/mocks/analyze.ts (analyzeLines) — this file cannot import it (a
// standalone function_handler), so the ~15 lines are duplicated here. Kept in
// sync by src/mocks/analyze.fn.parity.test.ts (reads this file, runs it, and
// diffs the output against analyzeLines()).
function handler({ request }) {
  const raw = request.body.lines
  const lines = Array.isArray(raw) ? raw.map(String) : []

  const words = []
  let i = 0
  for (const line of lines) {
    for (const text of line.split(/\s+/).filter(Boolean)) {
      const start = Math.round(i * 0.4 * 10) / 10
      const end = Math.round((start + 0.4) * 10) / 10
      words.push({ text, start, end })
      i += 1
    }
  }

  const counts = {
    columns: [{ key: 'line' }, { key: 'chars', type: 'number' }],
    rows: lines.map((line) => ({ line, chars: line.length })),
  }

  const snippet = 'export const lines = ' + JSON.stringify(lines)

  let longest = ''
  for (const line of lines) {
    if (line.length > longest.length) longest = line
  }

  return { words, counts, snippet, longest }
}
