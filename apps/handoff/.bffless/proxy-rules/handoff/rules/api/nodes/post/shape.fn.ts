import type { HandlerContext } from 'bffless/handlers';

/** The row `register_upload` echoes back — column casing varies, so every alias is read. */
interface RegisteredRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  nodeType?: string;
  displayName?: string;
  original_name?: string;
  filename?: string;
  title?: unknown;
  description?: unknown;
  content_type?: string | null;
  mime_type?: string | null;
  size?: unknown;
  url?: string | null;
  storage_path?: string | null;
  parentId?: string;
  ownerId?: string | null;
  createdMs?: unknown;
}

interface RegisterNodeBody {
  displayName?: string;
  storageKey?: string;
  parentId?: string;
  createdMs?: unknown;
}

interface Steps {
  register?: RegisteredRow;
}

/** Shape the freshly registered file row into the client-facing Node. */
export default function handler({ request, steps }: HandlerContext) {
  const r: RegisteredRow = ((steps as Steps) && (steps as Steps).register) || {};
  const body: RegisterNodeBody = ((request && request.body) as RegisterNodeBody) || {};
  const rawSize = r.size != null ? r.size : null;
  const size = rawSize != null ? Number(rawSize) : null;
  const rawCreated = r.createdMs != null ? r.createdMs : body.createdMs;
  const created = rawCreated != null ? Number(rawCreated) : 0;
  return {
    node: {
      id: r.id || r.recordId || r.record_id || null,
      type: r.nodeType || 'file',
      name: r.displayName || body.displayName || r.original_name || r.filename || 'Untitled',
      title: r.title != null && String(r.title) !== '' ? String(r.title) : null,
      description: r.description != null && String(r.description) !== '' ? String(r.description) : null,
      mime: r.content_type || r.mime_type || null,
      size: size != null && !isNaN(size) ? size : null,
      url: r.url || null,
      storageKey: r.storage_path || body.storageKey || null,
      parentId: r.parentId || body.parentId || 'root',
      ownerId: r.ownerId || null,
      mode: 'inheriting',
      grants: [],
      createdAt: created != null && !isNaN(created) ? created : 0,
    },
  };
}
