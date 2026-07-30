/**
 * Handoff's per-folder access-control primitives, as executed inside the pipeline sandbox.
 *
 * This is a port of `src/lib/acl.ts` (`evaluateAccess`) — that file is the canonical
 * statement of the model and the frontend uses it; this one is what actually gates live
 * requests. `src/lib/anyoneGrantRule.test.ts` holds the port-equivalence matrix that pins
 * the two together, so a change here without the matching change there fails the build.
 *
 * These functions used to be pasted, minified, into eleven separate handlers — one copy per
 * rule that needed a gate. They're a single module now, and each handler imports it (esbuild
 * inlines it per bundle at build time; the sandbox has no module loader).
 */

/** Access a viewer holds on a node, weakest → strongest. `rank` is the comparison order. */
export type AccessLevel = 'none' | 'view' | 'edit' | 'owner';

/** The reserved principal that makes a folder public — granting it is what "Public" means (ADR-0005). */
export const ANYONE_PRINCIPAL = 'anyone';

/** Node ids are record UUIDs; the walk stops at anything else (the 'root' sentinel, '', undefined). */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Ancestor-walk bound, so a corrupt parentId cycle can't hang the request. */
const MAX_CHAIN_DEPTH = 64;

export interface Grant {
  principalId?: string;
  level?: string;
}

/** One link of a resolved folder chain, ordered root-first (index 0 is the outermost ancestor). */
export interface ChainNode {
  id: string;
  ownerId: string | null;
  grants: Grant[];
  mode: 'inheriting' | 'restricted';
}

/** Who is asking. A logged-out share-link visitor has no `userId`, only a `shareLinkFolderId`. */
export interface Viewer {
  userId?: string | null;
  isAdmin?: boolean;
  /** Group ids the viewer belongs to — from the pipeline context's user.groups. */
  groupIds?: string[] | null;
  shareLinkFolderId?: string | null;
}

/** A raw `handoff_nodes` row as `data_query` returns it. Frozen by the runtime — never mutate. */
export interface NodeRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  nodeType?: string;
  parentId?: string;
  ownerId?: string | null;
  grantsJson?: unknown;
  mode?: string;
  [key: string]: unknown;
}

/** Comparison order for access levels. Anything unrecognised ranks as no access. */
export function rank(level: string | null | undefined): number {
  if (level === 'owner') return 3;
  if (level === 'edit') return 2;
  if (level === 'view') return 1;
  return 0;
}

/** A row's record id, whichever casing the query returned it under. */
export function idOf(node: NodeRow | null | undefined): string | null {
  if (!node) return null;
  return node.id || node.recordId || node.record_id || null;
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
  return Array.isArray(grants) ? (grants as Grant[]) : [];
}

/**
 * Walk `startId` up to the root, returning the chain root-first.
 *
 * The synthetic `'root'` sentinel resolves to the singleton root record's UUID, so a grant or
 * share link scoped to root is actually present in the chain (without this the walk stopped at
 * the sentinel and root-scoped access never matched).
 */
export function folderChain(nodes: NodeRow[], startId: string | null | undefined): ChainNode[] {
  const byId: Record<string, NodeRow> = {};
  let rootId = '';
  for (const node of nodes) {
    const row = node || ({} as NodeRow);
    const id = idOf(row);
    if (!id) continue;
    byId[id] = row;
    if (row.nodeType === 'root') rootId = id;
  }

  const resolve = (id: string): string => (id === 'root' && rootId ? rootId : id);

  const leafFirst: ChainNode[] = [];
  let cur = resolve(String(startId || ''));
  let depth = 0;
  while (cur && UUID_RE.test(cur) && byId[cur] && depth < MAX_CHAIN_DEPTH) {
    const node = byId[cur];
    leafFirst.push({
      id: cur,
      ownerId: node.ownerId || null,
      grants: parseGrants(node.grantsJson),
      mode: node.mode === 'restricted' ? 'restricted' : 'inheriting',
    });
    cur = resolve(String(node.parentId || ''));
    depth++;
  }

  return leafFirst.reverse();
}

/**
 * The access `viewer` holds over the node whose ancestry is `chain` (root-first).
 *
 * Order matters, and each step is load-bearing:
 *  1. admins hold owner on everything;
 *  2. owning any folder in the chain wins outright;
 *  3. a `restricted` folder cuts inheritance — only grants from the LAST restricted boundary
 *     downward count, which is what keeps a restricted subfolder private inside a shared parent;
 *  4. across that span the highest grant wins, and an `anyone` grant applies to every viewer
 *     (anonymous included) but is capped at `view` — publicness can never escalate;
 *  5. a logged-out share-link visitor gets `view`, but only on the linked folder and its
 *     descendants (i.e. only if that folder is in this chain).
 */
export function evalAccess(chain: ChainNode[], viewer: Viewer): AccessLevel {
  if (viewer.isAdmin) return 'owner';

  if (viewer.userId) {
    for (const node of chain) {
      if (node.ownerId === viewer.userId) return 'owner';
    }
  }

  let start = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].mode === 'restricted') {
      start = i;
      break;
    }
  }

  let best: AccessLevel = 'none';
  for (let i = start; i < chain.length; i++) {
    const grants = chain[i].grants || [];
    for (const entry of grants) {
      const grant = entry || ({} as Grant);
      if (grant.principalId === ANYONE_PRINCIPAL) {
        if (rank('view') > rank(best)) best = 'view';
      } else if (viewer.userId && grant.principalId === viewer.userId && rank(grant.level) > rank(best)) {
        best = grant.level as AccessLevel;
      } else if (
        viewer.groupIds &&
        grant.principalId &&
        viewer.groupIds.indexOf(grant.principalId) !== -1 &&
        rank(grant.level) > rank(best)
      ) {
        best = grant.level as AccessLevel;
      }
    }
  }

  if (!viewer.userId && viewer.shareLinkFolderId) {
    const inChain = chain.some((node) => node.id === viewer.shareLinkFolderId);
    if (inChain && rank('view') > rank(best)) best = 'view';
  }

  return best;
}
