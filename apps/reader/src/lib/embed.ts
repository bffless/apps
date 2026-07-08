/**
 * Inline-embed seam for the reading pane.
 *
 * Rivulet embeds a Handoff markdown post's rendered body by iframing the
 * Handoff viewer (Task 3 plumbing; the ReadingPane branch consumes these). Two
 * concerns live here, both pure so they unit-test trivially:
 *
 * - **Detection** — is an item embeddable? v1 keys off the feed-supplied
 *   enclosure mime (`text/markdown`).
 * - **Trust** — the mime alone is not enough. A hostile feed could set
 *   `enclosureType: 'text/markdown'` and point `link` at an arbitrary site to
 *   get us to iframe it. So embedding is gated on `link`'s **origin** being in
 *   a known-Handoff allowlist; a different host, scheme, or subdomain fails.
 */

import type { Item } from './items'

/**
 * The v1 allowlist of Handoff origins we'll iframe. A small hardcoded constant
 * on purpose (per the design) — a per-feed "embeddable" flag or configurable
 * allowlist is a later extension, not an env var in v1.
 */
export const TRUSTED_EMBED_ORIGINS: readonly string[] = ['https://handoff.j5s.dev']

/**
 * Turn a viewer `link` into its embeddable form by setting `embed=1`, while
 * preserving any existing query (notably `?token=` for private posts). Returns
 * `null` when `link` is falsy or unparseable, so callers can branch on a single
 * value. Overwrites `embed` if already present (idempotent-ish).
 */
export function embedUrl(link: string | null | undefined): string | null {
  if (!link) return null
  try {
    const url = new URL(link)
    url.searchParams.set('embed', '1')
    return url.toString()
  } catch {
    return null
  }
}

/**
 * The bare host of a viewer `link` (e.g. `handoff.j5s.dev`), for the "embedded
 * from <host>" label on the inline iframe. Returns `null` for a falsy or
 * unparseable link so the caller can drop the "from …" clause entirely.
 */
export function embedHost(link: string | null | undefined): string | null {
  if (!link) return null
  try {
    return new URL(link).host
  } catch {
    return null
  }
}

/**
 * Whether an item's body can be embedded inline via the Handoff viewer. True
 * IFF the enclosure mime is exactly `text/markdown` (v1 detection) **and**
 * `link` parses to an origin in {@link TRUSTED_EMBED_ORIGINS}. Fully defensive:
 * a null/empty/unparseable link or any other mime yields `false`. The
 * `trustedOrigins` list is injectable for tests; callers normally omit it.
 */
export function isEmbeddable(
  item: Pick<Item, 'enclosureType' | 'link'>,
  trustedOrigins: readonly string[] = TRUSTED_EMBED_ORIGINS,
): boolean {
  if (item.enclosureType !== 'text/markdown') return false
  if (!item.link) return false
  try {
    const { origin } = new URL(item.link)
    return trustedOrigins.includes(origin)
  } catch {
    return false
  }
}
