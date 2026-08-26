/**
 * `render: code` (02): highlighted source through the fixed language set
 * `src/lib/highlight.ts` registers. `data-language` always carries the
 * *requested* language (`mapping.language`, or empty) regardless of whether
 * it was recognised, so a caller can always see what was asked for.
 *
 * A requested language outside the registered set never falls back to
 * `hljs.highlightAuto` guessing — it renders the source as plain, escaped
 * text (React's normal text-node escaping, no `dangerouslySetInnerHTML`)
 * with a small label naming what was requested. Line numbers via CSS
 * counters (`.code-line`, `src/index.css`) only apply to that plain path:
 * splitting hljs's own highlighted markup per line would risk breaking a
 * token span across two lines, so the highlighted path accepts no per-line
 * numbering rather than risk that.
 */
import { highlightCode } from '../../../lib/highlight'

function readLanguage(mapping: unknown): string | undefined {
  if (mapping === null || typeof mapping !== 'object') return undefined
  const m = mapping as Record<string, unknown>
  return typeof m.language === 'string' ? m.language : undefined
}

export function CodeView({ value, mapping }: { value: unknown; mapping: unknown }) {
  const source = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const requested = readLanguage(mapping)
  const { html } = highlightCode(source, requested)

  return (
    <pre className="code-view">
      {html !== null ? (
        // `highlightCode` only returns `html` when it came from `hljs.highlight`,
        // which escapes its own output — never raw user content (mirrors
        // MarkdownView's `dangerouslySetInnerHTML` justification).
        <code
          data-testid="renderer"
          data-render="code"
          data-language={requested ?? ''}
          className={`hljs language-${requested ?? ''}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
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
