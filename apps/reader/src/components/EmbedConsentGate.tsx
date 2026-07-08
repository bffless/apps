/**
 * Placeholder shown in the reading pane *instead of* an embedded `<iframe>`,
 * until the reader consents to load content from its origin (see
 * `embedConsent.ts`). Outlook's "this message has blocked content" bar, adapted:
 * embeds run the sender's code, so nothing loads until the reader opts in.
 *
 * Two actions — **Show content** (this item, this session) and **Always allow
 * `<host>`** (persisted) — plus an escape hatch to open the original in Handoff.
 * Sized to fill the same region the iframe would, so loading it doesn't jump the
 * layout.
 */
export function EmbedConsentGate({
  host,
  link,
  onShowOnce,
  onAllowAlways,
}: {
  host: string | null
  link: string | null
  onShowOnce: () => void
  onAllowAlways: () => void
}) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 px-6 py-12 text-center dark:border-slate-700"
      style={{ minHeight: 'calc(100vh - 12rem)' }}
    >
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        {/* eye-off — content is hidden */}
        <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-6 w-6">
          <path d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" />
          <path d="M10.748 13.93l2.523 2.523a10.003 10.003 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
        </svg>
      </span>

      <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Embedded content isn’t shown</h2>
      <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        This item embeds content from{' '}
        <span className="font-medium text-slate-700 dark:text-slate-300">{host ?? 'another site'}</span>. It can run the
        sender’s code, so Rivulet doesn’t load it until you allow it.
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onShowOnce}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Show content
        </button>
        {host && (
          <button
            type="button"
            onClick={onAllowAlways}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Always allow {host}
          </button>
        )}
      </div>

      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-4 text-xs text-slate-400 underline decoration-dotted underline-offset-2 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
        >
          Open original ↗
        </a>
      )}
    </div>
  )
}
