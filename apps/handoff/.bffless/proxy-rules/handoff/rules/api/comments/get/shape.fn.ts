/**
 * Shape the comment listing. Soft-deleted roots (kept so their replies
 * survive) go out as husks: id/nodeId/parentId/deleted/createdMs only — no
 * body, author, anchor, or reactions leak after deletion.
 */
import type { HandlerContext } from 'bffless/handlers';

interface Row { [key: string]: unknown }

export default function handler({ steps }: HandlerContext) {
  const s = (steps || {}) as { comments?: Row[] };
  const rows: Row[] = Array.isArray(s.comments) ? s.comments : [];
  const out: Row[] = [];
  for (const raw of rows) {
    const r = raw || ({} as Row);
    const id = r.id || r.recordId || r.record_id || null;
    if (!id) continue;
    const isDeleted = r.deleted === true || r.deleted === 'true';
    if (isDeleted) {
      out.push({ id: id, nodeId: r.nodeId, parentId: r.parentId || '', deleted: true, createdMs: r.createdMs });
      continue;
    }
    out.push({
      id: id, nodeId: r.nodeId, parentId: r.parentId || '',
      authorId: r.authorId, authorName: r.authorName || '',
      body: r.body || '', anchorJson: r.anchorJson || null,
      resolved: r.resolved === true || r.resolved === 'true',
      resolvedBy: r.resolvedBy || null, resolvedMs: r.resolvedMs || null,
      reactionsJson: r.reactionsJson || null,
      deleted: false, createdMs: r.createdMs, updatedMs: r.updatedMs || null,
    });
  }
  return { comments: JSON.stringify(out) };
}
