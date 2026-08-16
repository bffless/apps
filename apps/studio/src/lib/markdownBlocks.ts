/**
 * Block splitting for the blog Markdown preview — pure, so it can be tested
 * without rendering. See `MarkdownPreview` for the renderer.
 */

export type MarkdownBlock = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string }

/** Opening line of a fenced code block: ``` or ~~~ (3+), with an optional info
 *  string whose first word is the language. */
const FENCE_OPEN = /^(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/

/**
 * Split the body into blocks: a fenced code block (``` … ```) is ONE block no
 * matter how many blank lines it contains; everything else splits on blank
 * lines as before. An unterminated fence runs to the end of the post.
 */
export function splitBlocks(body: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  const lines = body.split('\n')
  let buf: string[] = []
  const flush = () => {
    if (!buf.length) return
    for (const b of buf.join('\n').split(/\n{2,}/)) {
      const t = b.trim()
      if (t) out.push({ kind: 'text', text: t })
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
