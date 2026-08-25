/**
 * The two browser capabilities every `IslandHost` needs, in one place, because
 * two very different callers build a host: the runner middleware (a step's
 * island) and `IslandView` (a `render: island` viewer). Neither should have its
 * own idea of how the harness fetches a bundle file or opens a link.
 *
 * `credentials: 'same-origin'` is the whole point of the harness doing the
 * fetch: the island's own frame has an opaque origin and could not send the
 * member's session cookie itself (Decision 9).
 */

export async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, { credentials: 'same-origin' })
  // A non-2xx body is still read: the host reports the status, and a bundle
  // server's error page is occasionally the only clue about why.
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

/**
 * `ui/open-link`. Already `isSafeUrl`-gated by the host, and opened with
 * `noopener` so the new tab cannot reach back into the harness through
 * `window.opener`.
 */
export function openLink(url: string): void {
  globalThis.open?.(url, '_blank', 'noopener')
}
