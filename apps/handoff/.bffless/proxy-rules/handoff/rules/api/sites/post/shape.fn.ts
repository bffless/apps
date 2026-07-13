import type { HandlerContext } from 'bffless/handlers';

/** The row `data_create` echoes back — column casing varies, so every alias is read. */
interface CreatedRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  nodeType?: string;
  displayName?: string;
  siteEntry?: string;
  url?: string | null;
  parentId?: string;
  ownerId?: string | null;
  mode?: string;
  createdMs?: unknown;
}

/** What the `build` step derived: the content path prefix, entry document and entry URL. */
interface BuildStep {
  path?: string;
  entry?: string;
  storagePrefix?: string;
  url?: string | null;
}

interface CreateSiteBody {
  name?: string;
  entry?: string;
  parentId?: string;
  createdMs?: unknown;
}

interface Steps {
  create?: CreatedRow;
  build?: BuildStep;
}

/** Shape the freshly created site row into the client-facing Node. */
export default function handler({ request, steps }: HandlerContext) {
  const r: CreatedRow = ((steps as Steps) && (steps as Steps).create) || {};
  const body: CreateSiteBody = ((request && request.body) as CreateSiteBody) || {};
  const build: BuildStep = ((steps as Steps) && (steps as Steps).build) || {};
  const id = r.id || r.recordId || r.record_id || null;
  const entry = r.siteEntry || build.entry || body.entry || 'index.html';
  const created =
    r.createdMs != null ? Number(r.createdMs) : body.createdMs != null ? Number(body.createdMs) : 0;
  const url = r.url || build.url || null;
  return {
    node: {
      id: id,
      type: r.nodeType || 'site',
      name: r.displayName || body.name || 'Untitled site',
      mime: null,
      size: null,
      url: url,
      storageKey: null,
      path: build.path || null,
      parentId: r.parentId || body.parentId || 'root',
      ownerId: r.ownerId || null,
      mode: r.mode || 'inheriting',
      grants: [],
      siteEntry: entry,
      createdAt: created != null && !isNaN(created) ? created : 0,
    },
  };
}
