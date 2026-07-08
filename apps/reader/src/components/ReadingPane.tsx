import { embedUrl, isEmbeddable } from '../lib/embed'
import { itemBodyHtml, type Item } from '../lib/items'
import { sanitizeHtml } from '../lib/sanitize'

/**
 * Right column: the reading pane. Feed HTML is stored raw and made safe **here**
 * via {@link sanitizeHtml} before it touches `dangerouslySetInnerHTML` — this is
 * the XSS boundary (D10). Nothing upstream is trusted.
 *
 * The header carries the manual read/unread toggle; auto-mark-on-open lives in
 * the list wiring, so this only surfaces the current flag and lets the reader
 * flip it back.
 */
export function ReadingPane({
  item,
  loading = false,
  measureClass = 'max-w-2xl',
  onToggleRead,
  onToggleStar,
  feedNameFor,
}: {
  item: Item | null
  /**
   * A deep-linked item is selected but the full item set hasn't loaded yet, so
   * it can't be resolved. Hold this loading state until items arrive rather than
   * flashing the empty placeholder (#144).
   */
  loading?: boolean
  /** Reading-measure max-width class from the width preference (#136). */
  measureClass?: string
  onToggleRead?: (item: Item) => void
  onToggleStar?: (item: Item) => void
  /**
   * Resolve the feed-name eyebrow shown above the title. Supplied only in mixed
   * views (river/all/folder/starred); omitted in a single-feed view where the
   * source is redundant. A `null` return (orphaned item) renders no eyebrow.
   */
  feedNameFor?: (item: Item) => string | null
}) {
  if (!item) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-16 text-center text-sm text-slate-400 dark:text-slate-500">
        {loading ? 'Loading…' : 'Select an item to read it here.'}
      </div>
    )
  }

  const clean = sanitizeHtml(itemBodyHtml(item))
  const feedName = feedNameFor?.(item) ?? null

  // Embed a trusted Handoff markdown post inline. `isEmbeddable` is the security
  // gate: it embeds only when the enclosure mime is `text/markdown` AND `link`'s
  // origin is a known-Handoff allowlist entry — that trust boundary is what makes
  // iframing a feed-supplied URL safe. Treat as embeddable only with a usable URL.
  const embed = isEmbeddable(item)
  const src = embed ? embedUrl(item.link) : null

  // The header is byte-identical in both the embed and non-embed branches; only
  // the body region below differs.
  const header = (
    <header className="mb-4 border-b border-slate-200 pb-4 dark:border-slate-800">
        {(onToggleRead || onToggleStar) && (
          <div className="mb-2 flex justify-end gap-1">
            {onToggleStar && (
              <button
                type="button"
                onClick={() => onToggleStar(item)}
                aria-pressed={item.starred}
                aria-label={item.starred ? 'Unstar' : 'Star'}
                className={`rounded px-2 py-1 text-xs font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 ${
                  item.starred ? 'text-amber-500' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {item.starred ? '★ Starred' : '☆ Star'}
              </button>
            )}
            {onToggleRead && (
              <button
                type="button"
                onClick={() => onToggleRead(item)}
                className="rounded px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              >
                {item.read ? 'Mark unread' : 'Mark read'}
              </button>
            )}
          </div>
        )}
        {feedName && (
          <p className="mb-1 truncate text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {feedName}
          </p>
        )}
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {item.link ? (
            <a href={item.link} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
              {item.title || '(untitled)'}
            </a>
          ) : (
            item.title || '(untitled)'
          )}
        </h1>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {item.author && <span>{item.author}</span>}
          {item.author && item.publishedAt && <span> · </span>}
          {item.publishedAt && <time>{new Date(item.publishedAt).toLocaleString()}</time>}
        </p>
    </header>
  )

  // Embeddable: render a REAL <iframe> in place of the sanitized-body div — a
  // deliberate bypass of the `dangerouslySetInnerHTML` sanitize path so DOMPurify
  // never sees (and can't strip) it. The reader does no markdown rendering; the
  // Handoff embed page renders its own reading measure inside the iframe. The
  // article is a full-height flex column and full-width (dropping the `mx-auto
  // ${measureClass}` measure) so the `flex-1` iframe fills the pane; the viewport
  // min-height floor guards against the flex chain failing to resolve (the classic
  // iframe-collapse trap).
  if (src) {
    return (
      <article className="flex h-full min-h-0 flex-col px-2 py-4">
        {header}
        <iframe
          src={src}
          title={item.title || '(untitled)'}
          // Same-origin here is the iframe's OWN Handoff origin (so the embed page
          // can reach its session/content), not the reader's — it grants no access
          // back to Rivulet.
          sandbox="allow-scripts allow-same-origin"
          className="w-full flex-1"
          style={{ minHeight: 'calc(100vh - 10rem)' }}
        />
      </article>
    )
  }

  return (
    <article className={`mx-auto px-2 py-4 ${measureClass}`}>
      {header}
      {clean ? (
        <div
          className="reader-content max-w-none text-sm leading-relaxed text-slate-800 dark:text-slate-200"
          // Sanitized immediately above; this is the single trusted injection point.
          dangerouslySetInnerHTML={{ __html: clean }}
        />
      ) : (
        <p className="text-sm text-slate-400 dark:text-slate-500">This item has no content.</p>
      )}
    </article>
  )
}
