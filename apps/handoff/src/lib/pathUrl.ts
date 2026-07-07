/**
 * Path-URL helpers (GitHub-style /tree//blob routes — spec
 * docs/superpowers/specs/2026-07-06-handoff-path-urls-design.md).
 *
 * URLs mirror structural-storage content paths exactly: no root segment, one
 * URL segment per node name, percent-encoded per segment. Decoding is
 * per-segment with malformed escapes kept raw — the same contract the serve
 * rules follow (PR #177) — so app URLs and content URLs never disagree.
 */

/** Per-segment encodeURIComponent, preserving the `/` separators. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg // malformed escape — keep raw
  }
}

/**
 * Extract the decoded content path from a location pathname under a route
 * prefix. Returns '' when the pathname is not under the prefix or has no
 * remainder. Empty segments (doubled or trailing slashes) are dropped.
 */
export function pathFromPathname(
  pathname: string,
  prefix: '/tree/' | '/blob/' | '/api/resolve/',
): string {
  if (!pathname.startsWith(prefix)) return ''
  return pathname
    .slice(prefix.length)
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeSegment)
    .join('/')
}

/** Folder listing URL. The root folder is the app root, not /tree/. */
export function treeUrl(path: string): string {
  return path ? `/tree/${encodePath(path)}` : '/'
}

/** File/Site viewer URL. */
export function blobUrl(path: string): string {
  return `/blob/${encodePath(path)}`
}

/**
 * RSS feed URL for a folder path. The root folder's feed is the tokenless
 * `/feed.xml`; every other folder is `/feed/<encoded path>.xml`. Mirrors the
 * `/feed/*` + `/feed.xml` proxy rules (Handoff RSS spine, #188). Sibling to
 * `shareLinkCopyUrl` — a private feed appends the share-link token (#189), which
 * makes the URL a bearer credential (ADR-0008); public feeds stay tokenless.
 */
export function feedUrl(path: string, token?: string): string {
  const base = path ? `/feed/${encodePath(path)}.xml` : '/feed.xml'
  return token ? `${base}?token=${token}` : base
}

/** The owning folder's path ('' for a root-level node). */
export function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i) : ''
}

/**
 * Canonical app URL for a node. Falls back to the legacy id routes when the
 * node has no path yet (e.g. a response from a not-yet-updated backend), so
 * links never break during rollout.
 */
export function nodeUrl(node: { type: string; path: string | null; id: string }): string {
  // The singleton root record's canonical app URL is the root path itself —
  // it has no content path of its own (top-level nodes are parented to the
  // 'root' sentinel, not to this record's id).
  if (node.type === 'root') return '/'
  if (node.type === 'folder') {
    return node.path != null ? treeUrl(node.path) : `/folder/${node.id}`
  }
  return node.path ? blobUrl(node.path) : `/view/${node.id}`
}

/**
 * Path prefix for breadcrumb crumb `index` (crumb 0 is the synthetic root, so
 * its path is '').
 */
export function crumbPathAt(crumbs: { name: string }[], index: number): string {
  return crumbs
    .slice(1, index + 1)
    .map((c) => c.name)
    .join('/')
}
