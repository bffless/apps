/**
 * WRITE gate for `POST /api/comments` — decide whether this viewer may create a comment
 * (root or reply) on this node.
 *
 * Unlike the read gate (`comments/get/gate.fn.ts`), a share-cookie (`hf_s`) visitor alone is
 * never enough: writing requires a session `user.id` in addition to view+ access (spec §7).
 * That's why `deny401`/`deny403` split on `uid` rather than on "any credential" the way the
 * read gate's `hasCred` does.
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

interface PreOut {
  ok?: boolean;
  isReply?: boolean;
  bodyValue?: string;
  parentIdValue?: string;
  anchorValue?: string;
}

/** A raw `handoff_comments` row as `data_query` returns it. */
interface CommentRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  nodeId?: unknown;
  parentId?: unknown;
  deleted?: unknown;
  [key: string]: unknown;
}

interface GateSteps {
  pre?: PreOut;
  allFolders?: NodeRow[];
  query?: NodeRow | null;
  parentComment?: CommentRow | null;
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
  const pre = s.pre || {};
  const folders: NodeRow[] = s.allFolders || [];
  let node: NodeRow | null = s.query || null;
  if (!(node && typeof node === 'object' && idOf(node))) node = null;

  // Reply target validation: must exist, be a live root, and belong to this node.
  let replyOk = true;
  if (pre.isReply === true) {
    const pc = s.parentComment;
    const pcId = pc ? pc.id || pc.recordId || pc.record_id || null : null;
    const pcDeleted = !!pc && (pc.deleted === true || pc.deleted === 'true');
    const nid = node ? idOf(node) : null;
    replyOk = !!pc && !!pcId && !pcDeleted && !pc.parentId && !!nid && String(pc.nodeId || '') === String(nid);
  }

  const badRequest = pre.ok !== true || !node || !replyOk;

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
  }

  // WRITE rule (spec §7): a session user id is mandatory — hf_s alone never writes.
  const allow = !badRequest && !!uid && rank(level) >= 1;
  const deny401 = !badRequest && !allow && !uid;
  const deny403 = !badRequest && !allow && !!uid;

  const email = ((user && (user as { email?: unknown }).email) || '') as string;
  return {
    allow: allow,
    badRequest: badRequest,
    deny401: deny401,
    deny403: deny403,
    authorName: String(email || ''),
    level: level,
    nowMs: Date.now(),
  };
}
