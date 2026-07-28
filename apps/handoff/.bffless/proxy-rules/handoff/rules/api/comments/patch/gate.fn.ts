/**
 * WRITE gate for `PATCH /api/comments` — decide whether this viewer may `edit` / `resolve` /
 * `reopen` / `react` on the target comment.
 *
 * Same write posture as `comments/post/gate.fn.ts`: a share-cookie (`hf_s`) visitor alone is
 * never enough — every op requires a session `user.id` in addition to view+ access on the
 * comment's node (spec §7). `edit` additionally requires the caller to be the comment's author
 * (even an admin cannot edit someone else's body). `resolve`/`reopen` only apply to root
 * comments — targeting a reply is a 400, not a 403. `react` toggles the caller's id into/out of
 * `reactionsJson[emoji]`; the resulting JSON is computed here (a `data_update` field can only
 * be a literal or a step path, never an expression) and written by `reactUpdate`.
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

/** What the `pre` step reports about the request body. */
interface PreOut {
  idOk?: boolean;
  op?: string;
  opOk?: boolean;
  newBody?: string;
  bodyOk?: boolean;
  emoji?: string;
  emojiOk?: boolean;
}

/** A raw `handoff_comments` row as `data_query` returns it. */
interface CommentRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  nodeId?: unknown;
  parentId?: unknown;
  authorId?: unknown;
  deleted?: unknown;
  reactionsJson?: unknown;
  [key: string]: unknown;
}

interface GateSteps {
  pre?: PreOut;
  comment?: CommentRow | null;
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

  const stok = verifyToken(utils, readCookie(request, 'hf_s'));
  const shareFolderId = stok && stok.s ? String(stok.s) : '';

  let viewer: Viewer;
  if (uid) viewer = { userId: uid, isAdmin: isAdmin };
  else if (shareFolderId) viewer = { shareLinkFolderId: shareFolderId };
  else viewer = {};

  const s = (steps || {}) as GateSteps;
  const pre: PreOut = s.pre || {};
  const folders: NodeRow[] = s.allFolders || [];
  let node: NodeRow | null = s.query || null;
  if (!(node && typeof node === 'object' && idOf(node))) node = null;

  const c = s.comment && idOf(s.comment as NodeRow) ? s.comment : null;
  const cDeleted = !!c && (c.deleted === true || c.deleted === 'true');
  const isRoot = !!c && !c.parentId;
  const isAuthor = !!c && !!uid && String(c.authorId || '') === uid;

  const opOk =
    pre.opOk === true &&
    (pre.op !== 'edit' || pre.bodyOk === true) &&
    (pre.op !== 'react' || pre.emojiOk === true) &&
    ((pre.op !== 'resolve' && pre.op !== 'reopen') || isRoot);

  const badRequest = pre.idOk !== true || !c || cDeleted || !node || !opOk;

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

  // All ops need a session + view access; `edit` additionally requires being the author.
  const canRead = !!uid && rank(level) >= 1;
  const permitted = pre.op === 'edit' ? canRead && isAuthor : canRead;

  const allow = !badRequest && permitted;
  const deny401 = !badRequest && !allow && !uid;
  const deny403 = !badRequest && !allow && !!uid;

  // react toggle — computed here because data_update can only write literals/paths, not
  // expressions, so the resulting reactionsJson must already be the final string.
  let reactions: Record<string, unknown>;
  try {
    reactions = JSON.parse(String((c && c.reactionsJson) || '{}')) || {};
  } catch {
    reactions = {};
  }
  if (allow && pre.op === 'react' && uid) {
    const key = String(pre.emoji);
    const cur = Array.isArray(reactions[key]) ? (reactions[key] as unknown[]).map(String) : [];
    const next = cur.indexOf(uid) >= 0 ? cur.filter((u) => u !== uid) : cur.concat([uid]);
    if (next.length) reactions[key] = next;
    else delete reactions[key];
  }

  return {
    badRequest: badRequest,
    deny401: deny401,
    deny403: deny403,
    doEdit: allow && pre.op === 'edit',
    doResolve: allow && (pre.op === 'resolve' || pre.op === 'reopen'),
    doReact: allow && pre.op === 'react',
    okFlag: allow,
    newBody: String(pre.newBody || ''),
    newResolved: pre.op === 'resolve',
    resolvedBy: uid || '',
    newReactionsJson: JSON.stringify(reactions),
    nowMs: Date.now(),
  };
}
