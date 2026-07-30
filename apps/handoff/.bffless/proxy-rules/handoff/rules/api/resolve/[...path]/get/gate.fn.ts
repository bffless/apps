/**
 * ACL gate for `GET /api/resolve/<path>` — resolve a human path to a node, then decide access.
 *
 * Two ways a path can resolve, in order:
 *  1. `nodeByKey` matched a leaf by its storage key (the path *is* the object key);
 *  2. otherwise walk the path segments down the folder tree by displayName, starting at root.
 *
 * A path that resolves to nothing is a 404 — we deliberately do not 403 an unknown path, but a
 * path that resolves and is not readable does 401/403 depending on whether a credential was
 * presented.
 */
import type { HandlerContext } from 'bffless/handlers';
import {
  evalAccess,
  folderChain,
  idOf,
  type AccessLevel,
  type ChainNode,
  type Grant,
  type NodeRow,
  type Viewer,
} from '../../../../../_shared/acl';

/** Payload of a Handoff signed cookie: base64url(JSON) + '.' + hmac, with an ms-epoch `exp`. */
interface SignedToken {
  exp?: number;
  /** `hf_s` only: the share link's folder id. */
  s?: string;
  [key: string]: unknown;
}

/** What the `parse` step extracted from the wildcard path. */
interface ParseStep {
  segments?: string[];
  path?: string;
  hasPath?: boolean;
}

interface GateSteps {
  allFolders?: NodeRow[];
  parse?: ParseStep;
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

/** `grantsJson` arrives as a JSON string (or, defensively, anything at all). */
function parseGrants(raw: unknown): Grant[] {
  let grants: unknown = raw;
  if (typeof grants === 'string') {
    try {
      grants = JSON.parse(grants);
    } catch {
      grants = [];
    }
  }
  if (!grants || !Array.isArray(grants)) return [];
  return grants as Grant[];
}

/** Client-facing shape of the resolved node. `path` is echoed back as requested. */
function shapeRow(r: NodeRow, path: string): Record<string, unknown> {
  const id = idOf(r);
  const t = r.nodeType || 'file';
  const size = typeof r.size === 'number' ? r.size : r.size != null ? Number(r.size) : null;
  const created =
    typeof r.createdMs === 'number' ? r.createdMs : r.createdMs != null ? Number(r.createdMs) : 0;
  const grants = parseGrants(r.grantsJson);
  return {
    id: id,
    type: t,
    name: r.displayName || r.original_name || r.filename || 'Untitled',
    mime: r.content_type || r.mime_type || null,
    size: size != null && !isNaN(size) ? size : null,
    url: r.url || null,
    storageKey: r.storage_path || null,
    path: path,
    parentId: r.parentId || 'root',
    ownerId: r.ownerId || null,
    mode: r.mode || 'inheriting',
    grants: grants,
    createdAt: created != null && !isNaN(created) ? created : 0,
  };
}

export default function handler({ user, request, steps, utils }: HandlerContext) {
  const uid = ((user && user.id) || null) as string | null;
  const isAdmin = !!user && user.role === 'admin';
  const groupIds = ((user && (user as { groups?: string[] }).groups) || undefined);

  const stok = verifyToken(utils, readCookie(request, 'hf_s'));
  const shareFolderId = stok && stok.s ? String(stok.s) : '';

  let viewer: Viewer;
  if (uid) viewer = { userId: uid, isAdmin: isAdmin, groupIds: groupIds };
  else if (shareFolderId) viewer = { shareLinkFolderId: shareFolderId };
  else viewer = {};

  const s = (steps || {}) as GateSteps;
  const folders: NodeRow[] = s.allFolders || [];

  const byId: Record<string, NodeRow> = {};
  for (const folder of folders) {
    const f = folder || ({} as NodeRow);
    const id0 = idOf(f);
    if (id0) byId[id0] = f;
  }

  const segs: string[] = (s.parse && s.parse.segments) || [];
  const reqPath = (s.parse && s.parse.path) || '';
  const hasPath = !!(s.parse && s.parse.hasPath);

  const rows: NodeRow[] = s.nodeByKey || [];
  const hit: NodeRow | null = rows && rows.length ? rows[0] : null;

  let node: Record<string, unknown> | null = null;
  let ch: ChainNode[] | null = null;

  if (hit && hasPath) {
    // The storage key matched a leaf directly — chain it under its parent folder.
    const hid = idOf(hit) as string;
    ch = folderChain(folders, hit.parentId);
    ch.push({ id: hid, ownerId: hit.ownerId || null, grants: [], mode: 'inheriting' });
    node = shapeRow(hit, reqPath);
  } else if (hasPath && segs.length) {
    // Walk the segments down the folder tree by displayName, one level at a time.
    let curParent = 'root';
    let cur: NodeRow | null = null;
    let curId: string | null = null;
    let ok = true;
    for (const seg of segs) {
      let found: NodeRow | null = null;
      let foundId: string | null = null;
      for (const fid in byId) {
        const ff = byId[fid];
        if (String(ff.parentId || 'root') === curParent && String(ff.displayName || '') === seg) {
          found = ff;
          foundId = fid;
          break;
        }
      }
      if (!found) {
        ok = false;
        break;
      }
      cur = found;
      curId = foundId;
      curParent = foundId as string;
    }
    if (ok && cur) {
      // A folder is already a link in its own chain — no synthetic leaf to append.
      ch = folderChain(folders, curId);
      node = shapeRow(cur, reqPath);
    }
  }

  const resolved = !!node;
  let level: AccessLevel = 'none';
  let allow = false;
  if (resolved) {
    level = evalAccess(ch as ChainNode[], viewer);
    allow = level !== 'none';
  }

  const hasCred = !!uid || !!shareFolderId;
  const deny401 = !allow && resolved && !hasCred;
  const deny403 = !allow && resolved && hasCred;
  const deny404 = !resolved;

  return {
    allow: allow,
    deny401: deny401,
    deny403: deny403,
    deny404: deny404,
    level: level,
    node: node,
  };
}
