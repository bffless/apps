/**
 * WRITE gate for `DELETE /api/comments?id=…` — author-only (v1: not even an admin may
 * moderate-delete someone else's comment). No per-folder ACL is consulted here — being the
 * comment's author is the entire authorization rule, so this gate deliberately does NOT
 * import the shared `folderChain`/`evalAccess` walk (unlike the other comments gates, which
 * also need view+ access on the node).
 *
 * A root comment that already has ≥1 reply is soft-deleted (`doSoft`): the row survives as a
 * husk (`deleted: true`, `body`/`authorName` cleared) so `parentId` stays resolvable for the
 * replies. The husk carries only `id`/`nodeId`/`parentId`/`deleted`/`createdMs`/`anchorJson` —
 * GET keeps `anchorJson` (only `body`/`authorName`/reactions are stripped), so a husk with
 * surviving replies still anchors at its original document position instead of falling into
 * "Unanchored" (an orphan husk with zero replies is filtered out client-side entirely — see
 * `threadsFor`). A reply, or a childless root, is hard-deleted (`doHard`).
 *
 * TOCTOU note: the `replies` step probes for existing replies before this gate runs and before
 * `hardDelete`/`softDelete` execute. A reply created in that window on a comment this gate
 * routes to `doHard` gets orphaned (its `parentId` now points at nothing) — orphans are
 * invisible client-side, since `threadsFor` drops replies without a live root. Accepted window,
 * not handled.
 */
import type { HandlerContext } from 'bffless/handlers';

/** A raw `handoff_comments` row as `data_query` returns it. */
interface CommentRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  parentId?: unknown;
  authorId?: unknown;
  deleted?: unknown;
  [key: string]: unknown;
}

/** What the `pre` step reports about `request.query.id`. */
interface PreOut {
  id?: string;
  idOk?: boolean;
}

interface GateSteps {
  pre?: PreOut;
  comment?: CommentRow | null;
  replies?: unknown;
}

/** A row's record id, whichever casing the query returned it under. */
function idOf(row: CommentRow | null | undefined): string | null {
  if (!row) return null;
  return row.id || row.recordId || row.record_id || null;
}

export default function handler({ user, steps }: HandlerContext) {
  const uid = ((user && user.id) || null) as string | null;

  const s = (steps || {}) as GateSteps;
  const pre: PreOut = s.pre || {};

  const c = s.comment && idOf(s.comment as CommentRow) ? (s.comment as CommentRow) : null;
  const alreadyDeleted = !!c && (c.deleted === true || c.deleted === 'true');
  const badRequest = pre.idOk !== true || !c || alreadyDeleted;
  const isAuthor = !!c && !!uid && String(c.authorId || '') === uid;
  const isRoot = !!c && !c.parentId;
  const hasReplies = Array.isArray(s.replies) && s.replies.length > 0;

  const allow = !badRequest && isAuthor;
  const deny401 = !badRequest && !allow && !uid;
  const deny403 = !badRequest && !allow && !!uid;

  return {
    badRequest: badRequest,
    deny401: deny401,
    deny403: deny403,
    doSoft: allow && isRoot && hasReplies,
    doHard: allow && !(isRoot && hasReplies),
    okFlag: allow,
    softFlag: allow && isRoot && hasReplies,
  };
}
