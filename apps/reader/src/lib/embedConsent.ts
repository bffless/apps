/**
 * Embedded-content consent — Rivulet's "don't load until you allow it" gate.
 *
 * An inline embed (see `embed.ts`) mounts a Handoff `<iframe>` that runs the
 * *content author's* code (a site executes its own JS; even markdown runs
 * Handoff's SPA). So, Outlook-style, embedded content is **not auto-loaded**:
 * the reading pane shows a placeholder until the user opts in.
 *
 * The consent decision keys on the embed's **origin/host**, which the reader
 * derives by parsing `item.link` itself — canonical and unspoofable. It does
 * **not** key on the enclosure mime: the mime is feed-supplied and forgeable, so
 * a feed could label a JS site `text/markdown` to look "safe". Because the gate
 * is origin-keyed and covers every embed, that lie gains nothing.
 *
 * Two tiers, matching Outlook's "show once" vs "always trust this sender":
 * - **Always allow `<host>`** — persisted to `localStorage`; every embed from
 *   that host auto-loads thereafter. Decide once.
 * - **Show content** — an ephemeral, per-item allowance for the current session.
 *
 * This module is pure (storage is injectable) so it unit-tests without a DOM.
 */

/** Colon-namespaced like the other Rivulet keys (`rivulet:theme`). */
export const EMBED_ALLOWED_HOSTS_KEY = 'rivulet:embed-allowed-hosts'

/** localStorage if present, else null (SSR / privacy-mode safe). */
function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/**
 * The persisted set of always-allowed embed hosts. Tolerant of a missing,
 * corrupt, or non-array value → `[]` (a stale entry never throws).
 */
export function loadAllowedHosts(storage: Storage | null = defaultStorage()): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(EMBED_ALLOWED_HOSTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((h): h is string => typeof h === 'string' && h.length > 0)
  } catch {
    return []
  }
}

/**
 * Persist `host` to the always-allow list (deduped) and return the new list.
 * A no-op (returns the current list) when `host` is falsy or already present.
 * Storage failures are non-fatal — the allowance just won't survive a reload.
 */
export function persistAllowedHost(host: string, storage: Storage | null = defaultStorage()): string[] {
  const current = loadAllowedHosts(storage)
  if (!host || current.includes(host)) return current
  const next = [...current, host]
  try {
    storage?.setItem(EMBED_ALLOWED_HOSTS_KEY, JSON.stringify(next))
  } catch {
    // Non-fatal.
  }
  return next
}

/** Whether `host` is in the (already-loaded) always-allow list. */
export function isHostAllowed(host: string | null | undefined, allowed: readonly string[]): boolean {
  return !!host && allowed.includes(host)
}

// ---------------------------------------------------------------------------
// Session "show once" — ephemeral, per item id.
//
// Module-level so it survives a ReadingPane remount within the session; cleared
// only on a full reload (matching Outlook's per-message "show once").
// ---------------------------------------------------------------------------

const sessionShown = new Set<string>()

/** Mark this item as shown for the current session (no persistence). */
export function allowOnce(id: string): void {
  if (id) sessionShown.add(id)
}

/** Whether this item was shown-once this session. */
export function isAllowedOnce(id: string | null | undefined): boolean {
  return !!id && sessionShown.has(id)
}

/** Test helper — clears session show-once state. */
export function resetSessionConsent(): void {
  sessionShown.clear()
}
