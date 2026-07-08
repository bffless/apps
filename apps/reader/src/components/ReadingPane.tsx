import { embedHost, embedUrl, isEmbeddable } from '../lib/embed'
import { useEmbedConsent } from '../lib/useEmbedConsent'
import { itemBodyHtml, type Item } from '../lib/items'
import { sanitizeHtml } from '../lib/sanitize'
import { EmbedConsentGate } from './EmbedConsentGate'

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
  // Consent gate for inline embeds. Called before the early return below so hook
  // order stays stable across renders (item can be null).
  const consent = useEmbedConsent()

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-16 text-center text-sm text-slate-400 dark:text-slate-500">
        {loading ? 'Loading…' : 'Select an item to read it here.'}
      </div>
    )
  }

  const clean = sanitizeHtml(itemBodyHtml(item))
  const feedName = feedNameFor?.(item) ?? null

  // Embed a trusted Handoff content item (markdown post or HTML site) inline.
  // `isEmbeddable` is the *detection*+trust gate: the enclosure mime is embeddable
  // AND `link`'s origin is a known-Handoff allowlist entry — that origin boundary
  // is what makes iframing a feed-supplied URL safe. Treat as embeddable only with
  // a usable URL.
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
  // Handoff embed page renders the raw markdown inside the iframe.
  //
  // The iframe scrolls internally rather than growing the page: auto-sizing to
  // content height would need postMessage bubbled through *two* cross-origin
  // iframe boundaries (Rivulet → Handoff embed page → its own srcDoc markdown
  // frame), which isn't worth the fragility. So instead of pretending it's a
  // normal post, we make the seam explicit: a slim "embedded from <host>" bar
  // labels the region as a rendered-elsewhere document, so its own scrollbar
  // reads as intentional rather than a subtly-broken page.
  //
  // Layout: the embed reuses the **same** `mx-auto px-2 py-4 ${measureClass}`
  // shell as a normal post, so the header, source bar, and iframe line up with a
  // regular article's reading measure (they were visibly misaligned when the
  // iframe was full-bleed and Handoff imposed its own narrower measure). In embed
  // mode Handoff drops its inner max-width so the content fills the iframe — this
  // measure is the single source of truth. The iframe has no border and a
  // transparent body, so it blends into the card (no box-in-box). The viewport
  // min-height floor guards against the flex chain failing to resolve (the
  // classic iframe-collapse trap).
  if (src) {
    const host = embedHost(item.link)
    // Consent gate (Outlook-style): the embed is hidden until the reader allows
    // it. Keyed on the parsed `host` — NEVER `item.enclosureType`, which is
    // feed-supplied and forgeable (a feed could label a JS site `text/markdown`
    // to look safe). `open` is true only once the host is always-allowed or this
    // item was shown-once this session; otherwise we render the gate in place of
    // the iframe. The article header shows in both states.
    const open = !!host && (consent.isAllowed(host) || consent.isAllowedOnce(item.guid))
    return (
      <article className={`mx-auto flex h-full min-h-0 w-full flex-col px-2 py-4 ${measureClass}`}>
        {header}
        {open ? (
          <>
            <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
              <svg
                aria-hidden="true"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3.5 w-3.5 shrink-0"
              >
                <path fillRule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clipRule="evenodd" />
                <path fillRule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clipRule="evenodd" />
              </svg>
              <span className="min-w-0 truncate">
                Embedded document{host ? <> from <span className="font-medium">{host}</span></> : null}
              </span>
              {item.link && (
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  Open original ↗
                </a>
              )}
            </div>
            <iframe
              src={src}
              title={item.title || '(untitled)'}
              // Same-origin here is the iframe's OWN Handoff origin (so the embed
              // page can reach its session/content), not the reader's — it grants
              // no access back to Rivulet.
              sandbox="allow-scripts allow-same-origin"
              className="w-full flex-1 border-0"
              style={{ minHeight: 'calc(100vh - 12rem)' }}
            />
          </>
        ) : (
          <EmbedConsentGate
            host={host}
            link={item.link}
            onShowOnce={() => consent.allowOnce(item.guid)}
            onAllowAlways={() => consent.allowAlways(host)}
          />
        )}
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
