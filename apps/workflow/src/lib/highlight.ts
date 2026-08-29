/**
 * `render: code` (02): highlighting via `highlight.js`'s core build, with a
 * fixed, explicitly-registered language set — never `hljs.highlightAuto`,
 * which would guess at a language the definition never declared. Registering
 * through `lib/core` (not the full `highlight.js` bundle) keeps every
 * language the app doesn't use out of the bundle.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('python', python)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('markdown', markdown)

/**
 * Highlight `source` as `language` when it's one of the registered set.
 * `html` is `null` (not a best-effort guess) when the language is missing or
 * unregistered — the caller falls back to escaped plain text in that case.
 */
export function highlightCode(
  source: string,
  language: string | undefined,
): { html: string | null; language: string | null } {
  if (typeof language !== 'string' || !hljs.getLanguage(language)) {
    return { html: null, language: null }
  }
  const { value } = hljs.highlight(source, { language })
  return { html: value, language }
}

/**
 * Cut highlighted markup into one string per source line, so `CodeView` can
 * number the highlighted path the same way it numbers the plain one
 * (apps#380). Naively splitting on `\n` would tear a token span that covers
 * several lines — a block comment, a template literal — in half, leaving an
 * unclosed `<span>` on one line and a stray `</span>` on the next; this closes
 * every open tag at the line break and re-opens the same stack on the line
 * after, which is how hljs's own line-numbering plugins do it.
 *
 * The scan can be this simple because the input is hljs's own output and
 * nothing else: hljs escapes `&`, `<` and `>` in the source text it emits, so
 * every `<` left in the string starts a tag, and every tag is a `<span …>` or
 * a `</span>`. Never call this with arbitrary HTML.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let current = ''
  let i = 0

  const endLine = () => {
    lines.push(current + '</span>'.repeat(open.length))
    current = open.join('')
  }

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    const nl = html.indexOf('\n', i)

    if (nl !== -1 && (lt === -1 || nl < lt)) {
      current += html.slice(i, nl)
      endLine()
      i = nl + 1
      continue
    }

    if (lt === -1) {
      current += html.slice(i)
      break
    }

    current += html.slice(i, lt)
    const gt = html.indexOf('>', lt)
    if (gt === -1) {
      // Unterminated tag: nothing sane left to parse, so keep the rest verbatim.
      current += html.slice(lt)
      break
    }

    const tag = html.slice(lt, gt + 1)
    current += tag
    if (tag.startsWith('</')) open.pop()
    else if (!tag.endsWith('/>')) open.push(tag)
    i = gt + 1
  }

  lines.push(current + '</span>'.repeat(open.length))
  return lines
}
