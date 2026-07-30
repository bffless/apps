/**
 * ACL gate for `DELETE /api/node?id=…`.
 *
 * Deleting needs `edit` or better (`rank >= 2`), not merely `view`. On top of the ACL it
 * precomputes every branch the later pipeline steps need, because a BFFless step `condition`
 * can only reference a simple path — it cannot express `allow && isFile`, so each combination
 * has to arrive as its own plain boolean (`doPurge`, `doPurgeSite`, `doDelete`, …).
 *
 * Guard: a folder with children is never deleted (the client must empty it first), and the
 * root record can never be deleted at all.
 */
import type { HandlerContext } from 'bffless/handlers';
import {
  evalAccess,
  folderChain,
  idOf,
  rank,
  type AccessLevel,
  type ChainNode,
  type NodeRow,
  type Viewer,
} from '../../../../_shared/acl';

/** Payload of a Handoff signed cookie: base64url(JSON) + '.' + hmac, with an ms-epoch `exp`. */
interface SignedToken {
  exp?: number;
  /** `hf_s` only: the share link's folder id. */
  s?: string;
  [key: string]: unknown;
}

interface GateSteps {
  allFolders?: NodeRow[];
  query?: NodeRow | null;
  children?: unknown;
}

/** Storage paths are `…/uploads/<key>`; the object key is everything after this marker. */
const UPLOADS_MARKER = '/uploads/';

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
  const groupIds = ((user && (user as { groups?: string[] }).groups) || undefined);

  const stok = verifyToken(utils, readCookie(request, 'hf_s'));
  const shareFolderId = stok && stok.s ? String(stok.s) : '';

  let viewer: Viewer;
  if (uid) viewer = { userId: uid, isAdmin: isAdmin, groupIds: groupIds };
  else if (shareFolderId) viewer = { shareLinkFolderId: shareFolderId };
  else viewer = {};

  const s = (steps || {}) as GateSteps;
  const folders: NodeRow[] = s.allFolders || [];
  let node: NodeRow | null = s.query || null;
  if (node && typeof node === 'object') {
    const hasId = idOf(node);
    if (!hasId) node = null;
  } else {
    node = null;
  }

  let allow = false;
  let level: AccessLevel = 'none';
  let nodeType = '';
  let isFile = false;
  let isFolder = false;
  let isSite = false;
  let storageKey = '';

  if (node) {
    const nid = idOf(node) as string;
    nodeType = node.nodeType || 'file';
    isFile = nodeType === 'file';
    isFolder = nodeType === 'folder';
    isSite = nodeType === 'site';

    let ch: ChainNode[];
    if (isFolder) {
      ch = folderChain(folders, nid);
    } else {
      ch = folderChain(folders, node.parentId);
      ch.push({ id: nid, ownerId: node.ownerId || null, grants: [], mode: 'inheriting' });
    }
    level = evalAccess(ch, viewer);
    allow = rank(level) >= 2;

    const sp = String(node.storage_path || '');
    const um = sp.indexOf(UPLOADS_MARKER);
    storageKey = um >= 0 ? sp.slice(um + UPLOADS_MARKER.length) : '';
  }

  const kids = s.children || [];
  const childCount = Array.isArray(kids) ? kids.length : 0;
  const hasChildren = childCount > 0;
  const guardBlocked = (isFolder && hasChildren) || nodeType === 'root';

  const hasCred = !!uid || !!shareFolderId;
  const deny401 = !allow && !hasCred;
  const deny403 = !allow && hasCred;

  const doPurge = allow && isFile && !!storageKey;
  const sitePrefix = isSite && storageKey ? storageKey + '/' : '';
  const doPurgeSite = allow && isSite && !!sitePrefix;
  const doDelete = allow && !guardBlocked;

  return {
    allow: allow,
    deny401: deny401,
    deny403: deny403,
    level: level,
    isFile: isFile,
    isFolder: isFolder,
    isSite: isSite,
    storageKey: storageKey,
    childCount: childCount,
    hasChildren: hasChildren,
    guardBlocked: guardBlocked,
    doPurge: doPurge,
    doPurgeSite: doPurgeSite,
    sitePrefix: sitePrefix,
    doDelete: doDelete,
  };
}
