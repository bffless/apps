import { useRef, useState, type ChangeEvent } from 'react'
import type { Feed } from '../lib/feeds'
import { generateOpml, parseOpml, type OpmlFeed } from '../lib/opml'

/**
 * Import / export OPML. The parse + generate logic is the pure `lib/opml` seam
 * (unit-tested); this component only does the browser-side file I/O — reading the
 * picked file and triggering a download — then hands parsed feeds up via
 * `onImport` (which upserts + refreshes) and reads `feeds` for the export.
 */
export function OpmlControls({
  feeds,
  onImport,
  busy,
}: {
  feeds: Feed[]
  onImport: (parsed: OpmlFeed[]) => Promise<void>
  busy: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset so re-picking the same file fires `change` again.
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const parsed = parseOpml(await file.text())
      if (parsed.length === 0) {
        setError('No feeds found in that OPML file')
        return
      }
      await onImport(parsed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import that file')
    }
  }

  function handleExport() {
    const blob = new Blob([generateOpml(feeds)], { type: 'text/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'rivulet-subscriptions.opml'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const btn =
    'rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".opml,.xml,text/xml,application/xml"
          onChange={handleFile}
          className="hidden"
          aria-hidden
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={btn}
        >
          {busy ? 'Importing…' : 'Import OPML'}
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={busy || feeds.length === 0}
          className={btn}
        >
          Export OPML
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
