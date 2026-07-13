/**
 * ACL gate for `GET /api/uploads/content/<key>` — serving a stored object.
 *
 * The key either belongs to a node row directly (`nodeByKey`), or it lives *inside* a Site's
 * storage prefix (a site is one node but many objects: index.html, assets, …). For the latter
 * we pick the longest matching site prefix and inherit that site's access, so every asset of a
 * private site stays private and every asset of a shared one is reachable.
 *
 * A key that matches neither is a 404 — the caller learns nothing about what exists.
 */
import type { HandlerContext } from 'bffless/handlers';
import { evalAccess, folderChain, idOf, type AccessLevel, type NodeRow, type Viewer } from '../../../../../../_shared/acl';

/** Payload of a Handoff signed cookie: base64url(JSON) + '.' + hmac, with an ms-epoch `exp`. */
interface SignedToken {
  exp?: number;
  /** `hf_s` only: the share link's folder id. */
  s?: string;
  [key: string]: unknown;
}

interface GateSteps {
  allFolders?: NodeRow[];
  allSites?: NodeRow[];
  parsePath?: { fullKey?: string };
  nodeByKey?: NodeRow[];
}

/** Read one cookie off the raw header. The header can arrive as a string or a 1-element array. */
function readCookie(request: HandlerContext['request'], name: string): string {
  let raw: unknown = (request && request.headers && request.headers.cookie) || '';
  if (Array.isArray(raw)) raw = raw[0] || '';
  const cookie = String(raw);
  const parts = cookie.split(';');
  for (const kv of parts) {
    const p = kv.indexOf('=');
    if (p < 0) continue;
    const k = kv.slice(0, p).replace(/^\s+|\s+$/g, '');
    if (k === name) return decodeURIComponent(kv.slice(p + 1));
  }
  return '';
}

/** Verify a `<body>.<sig>` cookie token and return its payload, or null if invalid/expired. */
function verifyToken(utils: HandlerContext['utils'], tok: string): SignedToken | null {
  if (!tok) return null;
  const d = tok.lastIndexOf('.');
  if (d < 1) return null;
  const body = tok.slice(0, d);
  const sig = tok.slice(d + 1);
  if (!body || !sig) return null;
  if (!utils.verify(body, sig)) return null;
  let o: unknown;
  try {
    o = JSON.parse(utils.base64urlDecode(body));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const payload = o as SignedToken;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return payload;
}

export default function handler({ user, request, steps, utils }: HandlerContext) {
  const uid = ((user && user.id) || null) as string | null;
  const isAdmin = !!user && user.role === 'admin';

  const stok = verifyToken(utils, readCookie(request, 'hf_s'));
  const shareFolderId = stok && stok.s ? String(stok.s) : '';
  // NOTE: unlike the other gates, `hf_f` is NOT part of `hasCred` here — a folder token alone
  // does not turn a 401 into a 403 on content. (The original computed it and never used it.)

  let viewer: Viewer;
  if (uid) viewer = { userId: uid, isAdmin: isAdmin };
  else if (shareFolderId) viewer = { shareLinkFolderId: shareFolderId };
  else viewer = {};

  const s = (steps || {}) as GateSteps;
  const folders: NodeRow[] = s.allFolders || [];
  const sitesList: NodeRow[] = s.allSites || [];
  const fullKey = (s.parsePath && s.parsePath.fullKey) || '';

  const rows: NodeRow[] = s.nodeByKey || [];
  const node: NodeRow | null = rows && rows.length ? rows[0] : null;

  let allow = false;
  let level: AccessLevel = 'none';
  let resolved = false;

  if (node) {
    resolved = true;
    const ch = folderChain(folders, node.parentId);
    ch.push({ id: node.id as string, ownerId: node.ownerId || null, grants: [], mode: 'inheriting' });
    level = evalAccess(ch, viewer);
    allow = level !== 'none';
  } else {
    // No node owns this key outright — find the longest Site prefix that contains it.
    let best: NodeRow | null = null;
    let bestLen = -1;
    for (const site of sitesList) {
      const site0 = site || ({} as NodeRow);
      const sp = String(site0.storage_path || '');
      if (!sp) continue;
      if (fullKey === sp || fullKey.indexOf(sp + '/') === 0) {
        if (sp.length > bestLen) {
          bestLen = sp.length;
          best = site0;
        }
      }
    }
    if (best) {
      resolved = true;
      const sid = idOf(best) as string;
      const sch = folderChain(folders, best.parentId);
      sch.push({ id: sid, ownerId: best.ownerId || null, grants: [], mode: 'inheriting' });
      level = evalAccess(sch, viewer);
      allow = level !== 'none';
    }
  }

  const notFound = !resolved;
  const hasCred = !!uid || !!shareFolderId;
  const deny401 = !allow && !notFound && !hasCred;
  const deny403 = !allow && !notFound && hasCred;

  return {
    allow: allow,
    deny401: deny401,
    deny403: deny403,
    deny404: notFound,
    level: level,
    hasNode: !!node,
    resolved: resolved,
  };
}
