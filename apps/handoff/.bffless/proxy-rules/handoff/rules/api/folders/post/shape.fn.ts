import type { HandlerContext } from 'bffless/handlers';

/** The row `data_create` echoes back — column casing varies, so every alias is read. */
interface CreatedRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  nodeType?: string;
  displayName?: string;
  parentId?: string;
  ownerId?: string | null;
  mode?: string;
  createdMs?: unknown;
}

interface CreateFolderBody {
  name?: string;
  parentId?: string;
  createdMs?: unknown;
}

interface Steps {
  create?: CreatedRow;
}

/** Shape the freshly created folder row into the client-facing Node. */
export default function handler({ request, steps }: HandlerContext) {
  const r: CreatedRow = ((steps as Steps) && (steps as Steps).create) || {};
  const body: CreateFolderBody = ((request && request.body) as CreateFolderBody) || {};
  const created =
    r.createdMs != null ? Number(r.createdMs) : body.createdMs != null ? Number(body.createdMs) : 0;
  return {
    node: {
      id: r.id || r.recordId || r.record_id || null,
      type: r.nodeType || 'folder',
      name: r.displayName || body.name || 'Untitled folder',
      mime: null,
      size: null,
      url: null,
      storageKey: null,
      parentId: r.parentId || body.parentId || 'root',
      ownerId: r.ownerId || null,
      mode: r.mode || 'inheriting',
      grants: [],
      createdAt: created != null && !isNaN(created) ? created : 0,
    },
  };
}
