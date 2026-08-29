/**
 * Block splitting for the blog Markdown preview — pure, so it can be tested
 * without rendering. See `MarkdownPreview` for the renderer.
 */

/** A GFM table column's alignment, from its delimiter cell: `:--` left, `:-:`
 *  center, `--:` right, `---` unspecified (null — the renderer's default). */
export type TableAlign = 'left' | 'center' | 'right' | null

export type MarkdownBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; align: TableAlign[]; header: string[]; rows: string[][] }

/** Opening line of a fenced code block: ``` or ~~~ (3+), with an optional info
 *  string whose first word is the language. */
const FENCE_OPEN = /^(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/

/** One cell of a GFM table's delimiter row: dashes with an optional colon at
 *  either end (`---`, `:--`, `:-:`, `--:`). */
const DELIMITER_CELL = /^:?-+:?$/

/**
 * Split the body into blocks: a fenced code block (``` … ```) is ONE block no
 * matter how many blank lines it contains; everything else splits on blank
 * lines as before, and a blank-line-separated block that opens with a GFM table
 * (a row of `|` cells over a `|---|:-:|--:|` delimiter row) becomes a table
 * block. An unterminated fence runs to the end of the post.
 */
export function splitBlocks(body: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  const lines = body.split('\n')
  let buf: string[] = []
  const flush = () => {
    if (!buf.length) return
    for (const b of buf.join('\n').split(/\n{2,}/)) {
      const t = b.trim()
      if (!t) continue
      out.push(parseTable(t) ?? { kind: 'text', text: t })
    }
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i].trim())
    if (!open) {
      buf.push(lines[i])
      continue
    }
    flush()
    const marker = open[1][0]
    const closer = new RegExp(`^${marker === '`' ? '`' : '~'}{${open[1].length},}\\s*$`)
    const code: string[] = []
    let j = i + 1
    for (; j < lines.length && !closer.test(lines[j].trim()); j++) code.push(lines[j])
    out.push({ kind: 'code', lang: open[2].toLowerCase(), code: code.join('\n').replace(/\s+$/, '') })
    i = j
  }
  flush()
  return out
}

/**
 * Split one GFM table row into its cells: one optional leading and trailing `|`
 * is dropped, the rest splits on every unescaped `|`, and `\|` inside a cell
 * becomes a literal pipe. Cells are trimmed; inline Markdown is left for the
 * renderer.
 */
export function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cell += '|'
      i++
    } else if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell.trim())
  return cells
}

/**
 * A blank-line-separated block as a GFM table, or null when it isn't one. It is
 * a table when its first line has at least one `|` and its second line is a
 * delimiter row with the same number of cells as the header (the GFM rule — a
 * mismatch is not a table, so `| a |` over `| --- | --- |` stays prose). Every
 * later line is a body row, padded or truncated to the header's column count.
 */
export function parseTable(block: string): Extract<MarkdownBlock, { kind: 'table' }> | null {
  const lines = block.split('\n')
  if (lines.length < 2 || !lines[0].includes('|') || !lines[1].includes('|')) return null
  const header = splitTableRow(lines[0])
  const delimiter = splitTableRow(lines[1])
  if (delimiter.length !== header.length || !delimiter.every((c) => DELIMITER_CELL.test(c))) return null
  const align: TableAlign[] = delimiter.map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
  const rows = lines.slice(2).map((l) => {
    const cells = splitTableRow(l).slice(0, header.length)
    while (cells.length < header.length) cells.push('')
    return cells
  })
  return { kind: 'table', align, header, rows }
}
