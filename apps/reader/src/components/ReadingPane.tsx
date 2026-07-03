import { itemBodyHtml, type Item } from '../lib/items'
import { sanitizeHtml } from '../lib/sanitize'

/**
 * Right column: the reading pane. Feed HTML is stored raw and made safe **here**
 * via {@link sanitizeHtml} before it touches `dangerouslySetInnerHTML` — this is
 * the XSS boundary (D10). Nothing upstream is trusted.
 */
export function ReadingPane({ item }: { item: Item | null }) {
  if (!item) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-16 text-center text-sm text-slate-400">
        Select an item to read it here.
      </div>
    )
  }

  const clean = sanitizeHtml(itemBodyHtml(item))

  return (
    <article className="mx-auto max-w-2xl px-2 py-4">
      <header className="mb-4 border-b border-slate-200 pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          {item.link ? (
            <a href={item.link} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
              {item.title || '(untitled)'}
            </a>
          ) : (
            item.title || '(untitled)'
          )}
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          {item.author && <span>{item.author}</span>}
          {item.author && item.publishedAt && <span> · </span>}
          {item.publishedAt && <time>{new Date(item.publishedAt).toLocaleString()}</time>}
        </p>
      </header>
      {clean ? (
        <div
          className="reader-content max-w-none text-sm leading-relaxed text-slate-800"
          // Sanitized immediately above; this is the single trusted injection point.
          dangerouslySetInnerHTML={{ __html: clean }}
        />
      ) : (
        <p className="text-sm text-slate-400">This item has no content.</p>
      )}
    </article>
  )
}
