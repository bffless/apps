/**
 * ACL gate for `POST /api/sign` — minting a short-lived signed URL for a stored object.
 *
 * If the requested storage key maps to a known node, the viewer needs any access above `none`
 * on it. If it maps to nothing (`nodeByKey` empty), only an admin may sign — that's the escape
 * hatch for objects that have no node row (e.g. a key being written before its record exists).
 */
import type { HandlerContext } from 'bffless/handlers';
import { evalAccess, folderChain, type AccessLevel, type NodeRow, type Viewer } from '../../../../_shared/acl';

/** Payload of a Handoff signed cookie: base64url(JSON) + '.' + hmac, with an ms-epoch `exp`. */
interface SignedToken {
  exp?: number;
  /** `hf_s` only: the share link's folder id. */
  s?: string;
  [key: string]: unknown;
}

interface GateSteps {
  allFolders?: NodeRow[];
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
  // `hf_f` grants nothing on its own — it only counts as "the caller presented a credential",
  // which is what decides 401 vs 403 below.
  const ftok = verifyToken(utils, readCookie(request, 'hf_f'));

  let viewer: Viewer;
  if (uid) viewer = { userId: uid, isAdmin: isAdmin };
  else if (shareFolderId) viewer = { shareLinkFolderId: shareFolderId };
  else viewer = {};

  const s = (steps || {}) as GateSteps;
  const folders: NodeRow[] = s.allFolders || [];
  const rows: NodeRow[] = s.nodeByKey || [];
  const node: NodeRow | null = rows && rows.length ? rows[0] : null;

  let allow: boolean;
  let level: AccessLevel = 'none';
  if (node) {
    const ch = folderChain(folders, node.parentId);
    ch.push({ id: node.id as string, ownerId: node.ownerId || null, grants: [], mode: 'inheriting' });
    level = evalAccess(ch, viewer);
    allow = level !== 'none';
  } else {
    allow = isAdmin;
  }

  const hasCred = !!uid || !!shareFolderId || !!ftok;
  const deny401 = !allow && !hasCred;
  const deny403 = !allow && hasCred;

  return { allow: allow, deny401: deny401, deny403: deny403, level: level };
}
