/**
 * Resolve a feed's target folder, flatten its viewable subtree to leaves, and render RSS 2.0.
 *
 * Shared by BOTH feed rules — `/feed/<path>.xml` and the root `/feed.xml`. They ran byte-identical
 * copies of this handler before; now there is one file (ADR-0009's "three in-repo copies" is down
 * to two: `src/lib/feed.ts`, the reference implementation, and this, the one that actually serves).
 *
 * Access is evaluated with the same `evalAccess` the /api gates use:
 *  - a tokenless feed is evaluated as the anonymous public, so anything not granted to `anyone`
 *    (and any Restricted-private descendant) drops out;
 *  - a private feed carries a Share Link `?token=` (#189 / ADR-0008) and is evaluated as that
 *    share-link viewer, so the linked folder and its subtree surface.
 *
 * An unresolvable target — or one this viewer can't see — 404s rather than 200-with-nothing, so
 * the feed never leaks the existence of a private folder.
 */
import type { HandlerContext } from 'bffless/handlers';
import { evalAccess, folderChain, idOf, type NodeRow, type Viewer } from './acl';

/** The `/feed/*` rule's `parse` step output. */
interface ParseStep {
  path?: string;
  segments?: string[];
  isRoot?: boolean;
  bad?: boolean;
  token?: string;
}

/** The `link` step: the share_links row for `?token=`, when one was looked up. */
interface ShareLink {
  folderId?: string | null;
  revoked?: boolean | string;
  expiresMs?: number | string | null;
}

interface FeedItem {
  id: string | null;
  type: string;
  name: string;
  title: string | null;
  description: string | null;
  path: string;
  createdAt: number;
  mime: string | null;
  size: number | null;
}

export interface SelectResult {
  found: boolean;
  notfound: boolean;
  xml: string;
}

/** Max items in a feed, newest first. */
const MAX_ITEMS = 50;

/** Bound on the subtree walk, so a corrupt parent cycle can't hang the request. */
const MAX_WALK = 100000;

// --- node helpers ---------------------------------------------------------------------------

/**
 * A leaf's path is its stored key — `storage_path` minus the uploads-content prefix — the SAME
 * key /api/resolve and the content serve use. It is deliberately NOT rebuilt from displayName:
 * displayName is a human label (an API-set title, say) and can differ from the stored filename,
 * which would 404 both the item link and its media URL.
 */
function contentPath(node: NodeRow): string {
  const storagePath = String(node?.storage_path || '');
  const marker = '/uploads/content/';
  const at = storagePath.indexOf(marker);
  return at >= 0 ? storagePath.slice(at + marker.length) : '';
}

/** A feed-excluded folder keeps its whole subtree out of every feed, while staying browsable (#191 / ADR-0007). */
function isExcluded(node: NodeRow | undefined): boolean {
  return !!node && (node.feedExcluded === true || node.feedExcluded === 'true');
}

function mimeOf(node: NodeRow): string | null {
  return (node.content_type as string) || (node.mime_type as string) || null;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  if (typeof value === 'number') return isNaN(value) ? fallback : value;
  if (value == null) return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}

// --- RSS rendering (port of src/lib/feed.ts renderFeedXml) ----------------------------------

function xmlEscape(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** HTML-attribute-safe escape for text placed inside a CDATA `<img alt="...">`. */
function htmlAttr(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function descHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n?|\n/g, '<br>');
}

function humanSize(bytes: number | null): string {
  if (bytes == null || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size = size / 1024;
    unit++;
  }
  return (unit === 0 ? String(size) : size.toFixed(1)) + ' ' + units[unit];
}

function fileSummary(name: string, size: number | null): string {
  const human = humanSize(size);
  return human ? `${name} (${human})` : name;
}

function rfc822(ms: number): string {
  return new Date(ms).toUTCString();
}

function encPath(path: string): string {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function slugify(name: string): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot + 1) : '';
  const baseSlug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'file';
  const extSlug = ext.toLowerCase().replace(/[^a-z0-9]/g, '');
  return extSlug ? `${baseSlug}.${extSlug}` : baseSlug;
}

// --- handler --------------------------------------------------------------------------------

export default function handler({ request, steps }: HandlerContext): SelectResult {
  const allSteps = (steps || {}) as { allNodes?: NodeRow[]; parse?: ParseStep; link?: ShareLink };
  const nodes: NodeRow[] = allSteps.allNodes || [];
  const parse: ParseStep = allSteps.parse || {};

  // Viewer. A valid token (folder-scoped, not revoked, not expired) is evaluated as that
  // share-link visitor; an invalid/expired/revoked one falls back to the anonymous public, so a
  // private folder 404s rather than revealing that it exists.
  const token = String(parse.token || '');
  const link: ShareLink = allSteps.link && typeof allSteps.link === 'object' ? allSteps.link : {};
  const linkFolderId = link.folderId || null;
  const revoked = link.revoked === true || link.revoked === 'true';
  const expiresMs = link.expiresMs != null ? Number(link.expiresMs) : null;
  const expired = expiresMs != null && !isNaN(expiresMs) ? Date.now() > expiresMs : false;
  const tokenOk = !!token && !!linkFolderId && !revoked && !expired;

  const viewer: Viewer = tokenOk ? { shareLinkFolderId: linkFolderId } : {};
  // Threaded onto every item link, enclosure and the self href, so a reader fetches the feed and
  // its media with the same bearer token.
  const tokenQs = tokenOk ? `?token=${token}` : '';

  // Index by id, and find the root record.
  const byId: Record<string, NodeRow> = {};
  let rootId = '';
  for (const node of nodes) {
    const row = node || ({} as NodeRow);
    const id = idOf(row);
    if (!id) continue;
    byId[id] = row;
    if (row.nodeType === 'root') rootId = id;
  }
  const rootKey = rootId || 'root';

  // Children by NORMALIZED parent: a top-level node references the root as either the 'root'
  // sentinel or the root record's id — unify both onto rootKey.
  const childrenByParent: Record<string, NodeRow[]> = {};
  for (const node of nodes) {
    const row = node || ({} as NodeRow);
    const id = idOf(row);
    if (!id || id === rootId) continue;
    let parentId = row.parentId || 'root';
    if (parentId === 'root' || parentId === rootId) parentId = rootKey;
    (childrenByParent[parentId] = childrenByParent[parentId] || []).push(row);
  }

  // Resolve the target folder by name-walking the segments from the root (folders only).
  const segments = parse.segments || [];
  const isRoot = !!parse.isRoot;
  const bad = !!parse.bad;

  let targetId: string | null = null;
  let targetName = 'My Files';

  if (!bad && !isRoot) {
    let parentKey = rootKey;
    let found: NodeRow | null = null;
    let ok = true;
    for (const segment of segments) {
      const children = childrenByParent[parentKey] || [];
      let match: NodeRow | null = null;
      for (const child of children) {
        if (child.nodeType === 'folder' && String(child.displayName || '') === segment) {
          match = child;
          break;
        }
      }
      if (!match) {
        ok = false;
        break;
      }
      found = match;
      parentKey = idOf(match) as string;
    }
    if (ok && found) {
      targetId = idOf(found);
      targetName = String(found.displayName || 'Untitled');
    }
  } else if (isRoot && !bad) {
    targetId = rootKey;
    targetName = 'My Files';
  }

  // Unresolvable, or not viewable by this viewer → 404 (no existence leak).
  const viewable = targetId ? evalAccess(folderChain(nodes, targetId), viewer) !== 'none' : false;
  if (!targetId || !viewable) {
    return { found: false, notfound: true, xml: '' };
  }

  // Flatten the subtree to viewable leaves.
  const queue: string[] = isExcluded(byId[targetId]) ? [] : [targetId];
  const leaves: NodeRow[] = [];
  let guard = 0;
  while (queue.length && guard < MAX_WALK) {
    guard++;
    const parentKey = queue.shift() as string;
    for (const child of childrenByParent[parentKey] || []) {
      if (child.nodeType === 'folder') {
        if (!isExcluded(child)) queue.push(idOf(child) as string);
      } else if (child.nodeType === 'file' || child.nodeType === 'site') {
        if (evalAccess(folderChain(nodes, child.parentId), viewer) !== 'none') leaves.push(child);
      }
    }
  }

  let items: FeedItem[] = [];
  for (const leaf of leaves) {
    const path = contentPath(leaf);
    if (!path) continue;
    items.push({
      id: idOf(leaf),
      type: leaf.nodeType as string,
      name: String(leaf.displayName || leaf.original_name || leaf.filename || 'Untitled'),
      title: leaf.title != null && String(leaf.title) !== '' ? String(leaf.title) : null,
      description: leaf.description != null && String(leaf.description) !== '' ? String(leaf.description) : null,
      path,
      createdAt: numberOr(leaf.createdMs, 0) as number,
      mime: mimeOf(leaf),
      size: numberOr(leaf.size, null),
    });
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);

  let host = (request && request.headers && request.headers.host) || '';
  if (Array.isArray(host)) host = host[0] || '';
  const origin = host ? `https://${host}` : '';
  const path = parse.path || '';
  const treeLink = origin + (path ? `/tree/${encPath(path)}` : '/');
  const selfHref = origin + (path ? `/feed/${encPath(path)}.xml` : '/feed.xml') + tokenQs;
  const title = isRoot ? 'My Files' : targetName;

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">');
  out.push('<channel>');
  out.push('<title>' + xmlEscape(title) + '</title>');
  out.push('<link>' + xmlEscape(treeLink) + '</link>');
  out.push('<description>' + xmlEscape('Files and sites shared from ' + title) + '</description>');
  out.push('<atom:link href="' + xmlEscape(selfHref) + '" rel="self" type="application/rss+xml"/>');

  for (const item of items) {
    out.push('<item>');
    out.push('<title>' + xmlEscape(item.title || item.name) + '</title>');
    out.push('<link>' + xmlEscape(origin + '/blob/' + encPath(item.path) + tokenQs) + '</link>');
    out.push('<guid isPermaLink="false">' + xmlEscape(item.id) + '</guid>');
    out.push('<pubDate>' + rfc822(item.createdAt) + '</pubDate>');

    if (item.type === 'file') {
      const mime = item.mime || 'application/octet-stream';
      const length = item.size != null && item.size >= 0 ? item.size : 0;
      // A media URL a cross-domain reader can load with NONE of this app's cookies. Public feed:
      // serve the bytes directly (tokenless — the ACL 'Anyone' passes — and cacheable). Private
      // feed: use the token-in-URL redirect route (/r/), since /api/uploads/content is
      // cookie/session-gated and takes no ?token=. Never emit the presigned bucket URL itself (it
      // expires in ~5 min) — emit this stable indirection so it re-resolves per fetch.
      const mediaUrl = tokenOk
        ? `${origin}/r/${item.id}/${slugify(item.name)}${tokenQs}`
        : `${origin}/api/uploads/content/${encPath(item.path)}`;
      out.push(
        '<enclosure url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" length="' + length + '"/>',
      );

      const note = item.description ? '<p>' + descHtml(item.description) + '</p>' : '';
      const isImage = !!item.mime && item.mime.indexOf('image/') === 0;
      if (isImage) {
        // Reader/article views render <description>, NOT <enclosure>; an inline <img> gives them a
        // body plus the picture. CDATA keeps the HTML literal.
        out.push(
          '<description><![CDATA[' +
            note +
            '<p><img src="' +
            mediaUrl +
            '" alt="' +
            htmlAttr(item.name) +
            '" /></p>]]></description>',
        );
        out.push('<media:content url="' + xmlEscape(mediaUrl) + '" type="' + xmlEscape(mime) + '" medium="image"/>');
        out.push('<media:thumbnail url="' + xmlEscape(mediaUrl) + '"/>');
      } else if (note) {
        out.push('<description><![CDATA[' + note + ']]></description>');
      } else {
        out.push('<description>' + xmlEscape(fileSummary(item.name, item.size)) + '</description>');
      }
    } else {
      // Site: emit a text/html enclosure so our reader (Rivulet) embeds the site inline. The mime
      // is a detection hint only — the reader consent-gates on the link ORIGIN, not this label, so
      // a feed cannot skip consent by mislabelling. The <description> stays so non-embedding
      // readers still show a body.
      out.push(
        '<enclosure url="' + xmlEscape(origin + '/blob/' + encPath(item.path) + tokenQs) + '" type="text/html" length="0"/>',
      );
      if (item.description) {
        out.push('<description><![CDATA[<p>' + descHtml(item.description) + '</p>]]></description>');
      } else {
        out.push('<description>' + xmlEscape(item.name) + '</description>');
      }
    }
    out.push('</item>');
  }

  out.push('</channel>');
  out.push('</rss>');

  return { found: true, notfound: false, xml: out.join('\n') };
}
