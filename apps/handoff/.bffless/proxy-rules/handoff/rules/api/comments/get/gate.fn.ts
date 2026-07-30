/**
 * ACL gate for `GET /api/comments?nodeId=…` — decide whether this viewer may read comments
 * on this node at all (any level above `none`).
 *
 * The chain is built from `allFolders` (every folder + the root record); a non-folder node
 * isn't in that list, so it is appended as a synthetic leaf link with no grants of its own —
 * its access is entirely inherited from its parent folder chain.
 */
import type { HandlerContext } from 'bffless/handlers';
import {
  evalAccess,
  folderChain,
  idOf,
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
  pre?: { idOk?: boolean };
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
  if (node) {
    const nid = idOf(node) as string;
    const nt = node.nodeType || 'file';
    let ch: ChainNode[];
    if (nt === 'folder') {
      ch = folderChain(folders, nid);
    } else {
      ch = folderChain(folders, node.parentId);
      ch.push({ id: nid, ownerId: node.ownerId || null, grants: [], mode: 'inheriting' });
    }
    level = evalAccess(ch, viewer);
    allow = level !== 'none';
  }

  const pre = (s.pre || {}) as { idOk?: boolean };
  const badRequest = pre.idOk !== true || !node;

  const hasCred = !!uid || !!shareFolderId;
  const deny401 = !badRequest && !allow && !hasCred;
  const deny403 = !badRequest && !allow && hasCred;

  return { allow: !badRequest && allow, badRequest: badRequest, deny401: deny401, deny403: deny403, level: level };
}
