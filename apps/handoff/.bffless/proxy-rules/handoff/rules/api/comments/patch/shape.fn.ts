import type { HandlerContext } from 'bffless/handlers';

interface Row { [key: string]: unknown }

export default function handler({ steps }: HandlerContext) {
  const s = (steps || {}) as { final?: Row };
  const r: Row = (s.final && typeof s.final === 'object' ? s.final : {}) as Row;
  const id = r.id || r.recordId || r.record_id || null;
  return {
    comment: JSON.stringify({
      id: id, nodeId: r.nodeId, parentId: r.parentId || '',
      authorId: r.authorId, authorName: r.authorName || '',
      body: r.body || '', anchorJson: r.anchorJson || null,
      resolved: r.resolved === true || r.resolved === 'true',
      resolvedBy: r.resolvedBy || null, resolvedMs: r.resolvedMs || null,
      reactionsJson: r.reactionsJson || null, deleted: false,
      createdMs: r.createdMs, updatedMs: r.updatedMs || null,
    }),
  };
}
