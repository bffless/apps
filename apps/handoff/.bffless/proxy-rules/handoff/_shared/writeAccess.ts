/**
 * Handoff's write gate: may this caller create something under `parentId`?
 *
 * The four creation endpoints (POST /api/folders, /api/nodes, /api/sites,
 * /api/uploads/prepare) shipped without any access check — their `guard.fn.ts` decided
 * sibling-name collisions and nothing else. So an unauthenticated caller could create nodes
 * (which recorded `ownerId: null`, since the field is written from `user.id`), and any
 * authenticated user could create inside a folder they hold no access to. This module is the
 * check they were missing, built on the same primitives `DELETE /api/node` already uses.
 *
 * Two bars, matching how `GET /api/nodes` already treats root:
 *  - root (`parentId` absent or the literal `'root'`) is a shared landing area, so any
 *    authenticated user may create there — the listing rule likewise allows the request and
 *    filters per row;
 *  - a folder needs `edit` or better on its chain (`rank >= 2`), the same bar as delete.
 *
 * A share-link visitor's viewer caps at `view`, and an `anyone` grant is capped at `view` by
 * `evalAccess` itself, so neither can ever satisfy the folder bar. There is deliberately no
 * anonymous write path: `Edit` is not grantable to an anonymous principal.
 */
import type { HandlerContext } from 'bffless/handlers';
import {
  evalAccess,
  folderChain,
  rank,
  type AccessLevel,
  type NodeRow,
  type Viewer,
} from './acl';

/** Payload of a Handoff signed cookie: base64url(JSON) + '.' + hmac, with an ms-epoch `exp`. */
interface SignedToken {
  exp?: number;
  /** `hf_s` only: the share link's folder id. */
  s?: string;
  [key: string]: unknown;
}

/** The verdict, precomputed as plain booleans because a step `condition` cannot express logic. */
export interface WriteDecision {
  allow: boolean;
  deny401: boolean;
  deny403: boolean;
  /** Informational — the level the decision was made at. */
  level: AccessLevel;
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

/**
 * Who is asking — a signed-in user, a share-link visitor, or nobody.
 *
 * Every gate in the rule set had its own copy of this; the create gates import it instead of
 * adding four more.
 */
export function viewerFrom(ctx: Pick<HandlerContext, 'user' | 'request' | 'utils'>): Viewer {
  const user = ctx.user;
  const uid = ((user && user.id) || null) as string | null;
  const isAdmin = !!user && user.role === 'admin';
  const groupIds = (user && (user as { groups?: string[] }).groups) || undefined;

  if (uid) return { userId: uid, isAdmin: isAdmin, groupIds: groupIds };

  const stok = verifyToken(ctx.utils, readCookie(ctx.request, 'hf_s'));
  const shareFolderId = stok && stok.s ? String(stok.s) : '';
  if (shareFolderId) return { shareLinkFolderId: shareFolderId };

  return {};
}

/** Decide whether `viewer` may create a node under `parentId`. */
export function decideWrite(opts: {
  folders: NodeRow[];
  parentId: string;
  viewer: Viewer;
}): WriteDecision {
  const viewer: Viewer = opts.viewer || {};
  const parentId = String(opts.parentId || '');
  const isRoot = parentId === '' || parentId === 'root';
  const hasCred = !!viewer.userId || !!viewer.shareLinkFolderId;

  let level: AccessLevel = 'none';
  let allow = false;

  if (isRoot) {
    // Root is everyone's landing area: creating there needs an account, nothing more.
    allow = !!viewer.userId;
    level = allow ? (viewer.isAdmin ? 'owner' : 'edit') : 'none';
  } else {
    level = evalAccess(folderChain(opts.folders || [], parentId), viewer);
    allow = rank(level) >= 2;
  }

  return {
    allow: allow,
    deny401: !allow && !hasCred,
    deny403: !allow && hasCred,
    level: level,
  };
}
