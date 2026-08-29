/**
 * `render: code` (02): highlighted source through the fixed language set
 * `src/lib/highlight.ts` registers. `data-language` always carries the
 * *requested* language (`mapping.language`, or empty) regardless of whether
 * it was recognised, so a caller can always see what was asked for.
 *
 * A requested language outside the registered set never falls back to
 * `hljs.highlightAuto` guessing — it renders the source as plain, escaped
 * text (React's normal text-node escaping, no `dangerouslySetInnerHTML`)
 * with a small label naming what was requested.
 *
 * Both paths are numbered. Line numbers come from CSS counters over one
 * `.code-line` per source line (`src/index.css`); the highlighted path used to
 * go unnumbered because splitting hljs's markup naively risks tearing a token
 * span across a line break, which is exactly the job `splitHighlightedLines`
 * does properly — closing and re-opening the open-tag stack at each break
 * (apps#380).
 */
import { highlightCode, splitHighlightedLines } from '../../../lib/highlight'
import { codeLanguage } from './mapping'

export function CodeView({ value, mapping }: { value: unknown; mapping: unknown }) {
  const source = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const requested = codeLanguage(mapping)
  const { html } = highlightCode(source, requested)

  return (
    <pre className="code-view">
      {html !== null ? (
        <code
          data-testid="renderer"
          data-render="code"
          data-language={requested ?? ''}
          className={`hljs language-${requested ?? ''}`}
        >
          {splitHighlightedLines(html).map((line, i) => (
            // `highlightCode` only returns `html` when it came from
            // `hljs.highlight`, which escapes its own output — never raw user
            // content (mirrors MarkdownView's `dangerouslySetInnerHTML`
            // justification), and `splitHighlightedLines` only ever cuts that
            // output along line breaks.
            <span className="code-line" key={i} dangerouslySetInnerHTML={{ __html: line }} />
          ))}
        </code>
      ) : (
        <code data-testid="renderer" data-render="code" data-language={requested ?? ''}>
          <span className="code-view-language">{requested ?? 'plain'}</span>
          {source.split('\n').map((line, i) => (
            <span className="code-line" key={i}>
              {line}
            </span>
          ))}
        </code>
      )}
    </pre>
  )
}
