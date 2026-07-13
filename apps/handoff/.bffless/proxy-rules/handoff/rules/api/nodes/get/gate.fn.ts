/**
 * ACL gate for `GET /api/nodes?parentId=…` — the folder listing.
 *
 * Gates on the *parent* folder: may this viewer open the folder at all? Listing root is always
 * allowed (an empty/filtered listing is what an anonymous visitor sees), and per-row visibility
 * is then filtered by `shape`, which re-evaluates each child against the `viewer` returned here.
 */
import type { HandlerContext } from 'bffless/handlers';
import { evalAccess, folderChain, type NodeRow, type Viewer } from '../../../../_shared/acl';

/** Payload of a Handoff signed cookie: base64url(JSON) + '.' + hmac, with an ms-epoch `exp`. */
interface SignedToken {
  exp?: number;
  /** `hf_s` only: the share link's folder id. */
  s?: string;
  [key: string]: unknown;
}

/** What the `pre` step reports about the requested parent. */
interface ListPre {
  isRoot?: boolean;
  parentId?: string;
}

interface GateSteps {
  pre?: ListPre;
  allFolders?: NodeRow[];
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

  let viewer: Viewer;
  if (uid) viewer = { userId: uid, isAdmin: isAdmin };
  else if (shareFolderId) viewer = { shareLinkFolderId: shareFolderId };
  else viewer = {};

  const s = (steps || {}) as GateSteps;
  const folders: NodeRow[] = s.allFolders || [];
  const isRoot = !!(s.pre && s.pre.isRoot);
  const parentId = String((s.pre && s.pre.parentId) || 'root');

  let allow: boolean;
  if (isRoot) {
    allow = true;
  } else {
    const ch = folderChain(folders, parentId);
    allow = evalAccess(ch, viewer) !== 'none';
  }

  const hasCred = !!uid || !!shareFolderId;
  const deny401 = !allow && !hasCred;
  const deny403 = !allow && hasCred;

  // `viewer` is handed to `shape`, which re-evaluates every listed row against it.
  return { allow: allow, deny401: deny401, deny403: deny403, viewer: viewer, isRoot: isRoot };
}
