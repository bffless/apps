import type { HandlerContext } from 'bffless/handlers';

/** Node ids are record UUIDs; the ancestor walk stops at anything else. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The unified content endpoint, and the marker inside a stored `storage_path`. */
const CONTENT = '/api/uploads/content/';
const SPM = '/uploads/content/';

/** A `handoff_nodes` row as `data_query` returns it — column casing varies, so every alias is read. */
interface NodeRow {
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
  createdMs?: unknown;
  url?: string | null;
  grantsJson?: unknown;
  storage_path?: string;
  siteEntry?: string;
  parentId?: string;
  ownerId?: string | null;
  mode?: string;
  feedExcluded?: unknown;
}

interface Steps {
  /** The single node under lookup (record fetch), or nothing when the id was malformed. */
  query?: NodeRow | null;
  /** Every folder/root row, used to reconstruct a folder's human-readable path. */
  allFolders?: NodeRow[];
}

/** Shape one node row into the client-facing Node (null when the row is missing). */
export default function handler({ steps }: HandlerContext) {
  let r: NodeRow = (((steps as Steps) && (steps as Steps).query) as NodeRow) || {};
  const folders: NodeRow[] = ((steps as Steps) && (steps as Steps).allFolders) || [];
  const byId: Record<string, NodeRow> = {};
  for (let a = 0; a < folders.length; a++) {
    const f: NodeRow = folders[a] || {};
    const fid = f.id || f.recordId || f.record_id;
    if (fid) byId[fid] = f;
  }

  function folderPath(startId: string | null | undefined): string {
    const names: string[] = [];
    let cur = String(startId || '');
    let g = 0;
    while (cur && UUID.test(cur) && byId[cur] && g < 64) {
      names.push(String(byId[cur].displayName || 'Untitled'));
      cur = byId[cur].parentId || '';
      g++;
    }
    const out: string[] = [];
    for (let b = names.length - 1; b >= 0; b--) out.push(names[b]);
    return out.join('/');
  }

  if (r == null || typeof r !== 'object') r = {};
  const id = r.id || r.recordId || r.record_id || null;
  const t = r.nodeType || 'file';
  // (A `siteEntry` default was computed here and never used — dropped. A Site's entry reaches the
  // client through its stored `url`, which already points at the entry file.)
  const size = typeof r.size === 'number' ? r.size : r.size != null ? Number(r.size) : null;
  const created =
    typeof r.createdMs === 'number' ? r.createdMs : r.createdMs != null ? Number(r.createdMs) : 0;
  const url = r.url || null;

  let grants: unknown = r.grantsJson;
  if (typeof grants === 'string') {
    try {
      grants = JSON.parse(grants);
    } catch {
      grants = [];
    }
  }
  if (!grants || Object.prototype.toString.call(grants) !== '[object Array]') {
    grants = [];
  }

  const sp = r.storage_path || '';
  const mi = sp.indexOf(SPM);
  const nonFolderPath =
    mi >= 0
      ? sp.slice(mi + SPM.length)
      : url && url.indexOf(CONTENT) === 0
        ? url.slice(CONTENT.length)
        : null;

  const node = id
    ? {
        id: id,
        type: t,
        name: r.displayName || r.original_name || r.filename || 'Untitled',
        title: r.title != null && String(r.title) !== '' ? String(r.title) : null,
        description: r.description != null && String(r.description) !== '' ? String(r.description) : null,
        mime: r.content_type || r.mime_type || null,
        size: size != null && !isNaN(size) ? size : null,
        url: url,
        storageKey: r.storage_path || null,
        path: t === 'folder' ? folderPath(id) : nonFolderPath,
        parentId: r.parentId || 'root',
        ownerId: r.ownerId || null,
        mode: r.mode || 'inheriting',
        feedExcluded: r.feedExcluded === true || r.feedExcluded === 'true',
        grants: grants,
        createdAt: created != null && !isNaN(created) ? created : 0,
      }
    : null;

  return { node: node };
}
