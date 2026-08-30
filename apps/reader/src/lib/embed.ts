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
 *   get us to iframe it. So embedding is gated on `link`'s **origin** being
 *   trusted; a different scheme or a host outside the trusted set fails.
 */

import type { Item } from './items'

/**
 * Whether `origin` (an `https://host[:port]` string, as `new URL(link).origin`
 * yields) is one we'll iframe.
 *
 * Mirrors `adminOrigin()` in `session.ts`: Rivulet and Handoff are deployed as
 * sibling subdomains of one primary domain (`reader.<primary>`,
 * `handoff.<primary>`), so the trusted set is derived from **our own hostname**
 * and a fork works on any instance with no code edit, whatever labels the
 * installer picked. The rule: strip our first hostname label to get the primary
 * domain; trust any `https:` origin whose hostname is a subdomain of it. The
 * apex itself is not trusted, `http:` never is, and a single-label host
 * (`localhost`) has no primary domain, so nothing embeds there.
 *
 * Set `VITE_TRUSTED_EMBED_ORIGINS` (comma-separated origins, e.g.
 * `https://handoff.other.tld,https://docs.custom.tld`) at build time to
 * **replace** the rule with an exact-origin allowlist — for a Handoff on a
 * different domain, or local dev. Entries are trimmed and trailing slashes
 * stripped; nothing else is normalised, so write the origin exactly.
 */
export function isTrustedEmbedOrigin(origin: string): boolean {
  const override = import.meta.env.VITE_TRUSTED_EMBED_ORIGINS as string | undefined
  if (override) {
    const allowed = override
      .split(',')
      .map((entry) => entry.trim().replace(/\/+$/, ''))
      .filter(Boolean)
    return allowed.includes(origin)
  }
  const labels = window.location.hostname.split('.')
  // <app>.<primary…> → <primary…>; a single-label host has no primary domain.
  if (labels.length < 2) return false
  const primary = labels.slice(1).join('.')
  try {
    const { protocol, hostname } = new URL(origin)
    return protocol === 'https:' && hostname.endsWith(`.${primary}`)
  } catch {
    return false
  }
}

/**
 * Enclosure mimes we treat as embeddable Handoff content: markdown posts and
 * HTML sites. This is a **detection hint only** — it answers "is this an
 * embeddable content item?", not "is it safe to auto-load". The mime is
 * feed-supplied and therefore forgeable, so it must never gate the security
 * decision; that is the origin trust rule ({@link isTrustedEmbedOrigin}) plus
 * the per-origin consent gate (see `embedConsent`). A feed lying about the mime
 * gains nothing: the reader still iframes `link`, Handoff renders from the node
 * (not the label), and every embed is consent-gated on the parsed origin.
 */
export const EMBEDDABLE_MIMES: ReadonlySet<string> = new Set(['text/markdown', 'text/html'])

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
 * The bare host of a viewer `link` (e.g. `handoff.example.com`), for the
 * "embedded from <host>" label on the inline iframe. Returns `null` for a falsy
 * or unparseable link so the caller can drop the "from …" clause entirely.
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
 * IFF the enclosure mime is one of {@link EMBEDDABLE_MIMES} (markdown or HTML —
 * detection only) **and** `link` parses to an origin that `isTrusted` accepts
 * (the security gate, {@link isTrustedEmbedOrigin} by default). Fully
 * defensive: a null/empty/unparseable link or any other mime yields `false`.
 * The `isTrusted` predicate is injectable for tests; callers normally omit it.
 *
 * Note: this only decides whether the reader *offers* an embed. Whether it
 * auto-loads is a separate, origin-keyed consent decision (`embedConsent`) —
 * the mime never influences that, since it is feed-supplied and forgeable.
 */
export function isEmbeddable(
  item: Pick<Item, 'enclosureType' | 'link'>,
  isTrusted: (origin: string) => boolean = isTrustedEmbedOrigin,
): boolean {
  if (!item.enclosureType || !EMBEDDABLE_MIMES.has(item.enclosureType)) return false
  if (!item.link) return false
  try {
    const { origin } = new URL(item.link)
    return isTrusted(origin)
  } catch {
    return false
  }
}
