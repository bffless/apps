import { useState, type FormEvent } from 'react'

/**
 * The add-a-feed input. Pure presentation + local input state — the actual
 * subscribe (normalize URL, POST, refresh) is the parent's `onAdd`, so this
 * component has nothing to unit-test beyond what Vitest already covers in
 * `lib/feeds` and `lib/api`.
 */
export function AddFeed({
  onAdd,
  busy,
}: {
  onAdd: (url: string) => Promise<void>
  busy: boolean
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = url.trim()
    if (!value || busy) return
    setError(null)
    try {
      await onAdd(value)
      setUrl('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that feed')
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Add a feed or site URL…"
          aria-label="Feed or site URL"
          disabled={busy}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  )
}
