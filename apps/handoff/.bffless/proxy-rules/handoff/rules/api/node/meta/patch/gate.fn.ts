/**
 * ACL gate for `PATCH /api/node/meta` — editing a leaf's title/description.
 *
 * Only leaves (`file` / `site`) carry editable metadata, so anything else is a 400 rather than
 * a 403. Writing needs `edit` or better (`rank >= 2`).
 *
 * `doSaveTitle` / `doSaveDescription` are precomputed conjunctions because a BFFless step
 * `condition` can only reference a simple path — it cannot express `doSave && pre.hasTitle`.
 */
import type { HandlerContext } from 'bffless/handlers';
import {
  evalAccess,
  folderChain,
  idOf,
  rank,
  type AccessLevel,
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

/** What the `pre` step reports about the request body. */
interface MetaPre {
  idOk?: boolean;
  hasField?: boolean;
  hasTitle?: boolean;
  hasDescription?: boolean;
}

interface GateSteps {
  pre?: MetaPre;
  allFolders?: NodeRow[];
  query?: NodeRow | null;
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
  const s = (steps || {}) as GateSteps;
  const pre: MetaPre = s.pre || {};

  const uid = ((user && user.id) || null) as string | null;
  const isAdmin = !!user && user.role === 'admin';

  const stok = verifyToken(utils, readCookie(request, 'hf_s'));
  const shareFolderId = stok && stok.s ? String(stok.s) : '';

  let viewer: Viewer;
  if (uid) viewer = { userId: uid, isAdmin: isAdmin };
  else if (shareFolderId) viewer = { shareLinkFolderId: shareFolderId };
  else viewer = {};

  const folders: NodeRow[] = s.allFolders || [];
  let node: NodeRow | null = s.query || null;
  if (node && typeof node === 'object') {
    const hasId = idOf(node);
    if (!hasId) node = null;
  } else {
    node = null;
  }

  const nodeType = node ? node.nodeType || 'file' : '';
  const isLeaf = nodeType === 'file' || nodeType === 'site';
  const badRequest = pre.idOk !== true || pre.hasField !== true || !node || !isLeaf;

  let level: AccessLevel = 'none';
  let allow = false;
  if (node && isLeaf) {
    const nid = idOf(node) as string;
    const ch = folderChain(folders, node.parentId);
    ch.push({ id: nid, ownerId: node.ownerId || null, grants: [], mode: 'inheriting' });
    level = evalAccess(ch, viewer);
    allow = rank(level) >= 2;
  }

  const hasCred = !!uid || !!shareFolderId;
  const deny401 = !badRequest && !allow && !hasCred;
  const deny403 = !badRequest && !allow && hasCred;
  const doSave = !badRequest && allow;

  return {
    badRequest: badRequest,
    deny401: deny401,
    deny403: deny403,
    doSave: doSave,
    level: level,
    doSaveTitle: doSave === true && pre.hasTitle === true,
    doSaveDescription: doSave === true && pre.hasDescription === true,
  };
}
