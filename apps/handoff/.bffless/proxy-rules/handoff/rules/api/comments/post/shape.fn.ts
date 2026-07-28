import type { HandlerContext } from 'bffless/handlers';

interface Row { [key: string]: unknown }

export default function handler({ steps }: HandlerContext) {
  const s = (steps || {}) as { create?: Row };
  const r: Row = (s.create && typeof s.create === 'object' ? s.create : {}) as Row;
  const id = r.id || r.recordId || r.record_id || null;
  return {
    comment: JSON.stringify({
      id: id, nodeId: r.nodeId, parentId: r.parentId || '',
      authorId: r.authorId, authorName: r.authorName || '',
      body: r.body || '', anchorJson: r.anchorJson || null,
      resolved: false, resolvedBy: null, resolvedMs: null,
      reactionsJson: r.reactionsJson || null, deleted: false,
      createdMs: r.createdMs, updatedMs: null,
    }),
  };
}
