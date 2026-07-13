/**
 * Shape the folder listing for `GET /api/nodes`, and drop every row the viewer can't see.
 *
 * This is the per-row half of the ACL: `gate` decided whether the folder may be opened at all
 * and handed us its `viewer`; here each child is re-evaluated against its own chain, so a
 * `restricted` subfolder stays invisible inside a folder the viewer can otherwise read.
 *
 * `rootMeta.public` tells the client whether the root carries an `anyone` grant (ADR-0005) —
 * that's what the "Public" toggle reflects.
 */
import type { HandlerContext } from 'bffless/handlers';
import {
  ANYONE_PRINCIPAL,
  evalAccess,
  folderChain,
  idOf,
  type ChainNode,
  type Grant,
  type NodeRow,
  type Viewer,
} from '../../../../_shared/acl';

/** Node ids are record UUIDs; the name walk stops at anything else. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Ancestor-walk bound, so a corrupt parentId cycle can't hang the request. */
const MAX_DEPTH = 64;

/** A leaf's public content URL prefix, and the storage-path marker that precedes its key. */
const CONTENT = '/api/uploads/content/';
const SPM = '/uploads/content/';

interface ShapeSteps {
  allFolders?: NodeRow[];
  query?: NodeRow[];
  gate?: { viewer?: Viewer };
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
  if (!grants || !Array.isArray(grants)) return [];
  return grants as Grant[];
}

export default function handler({ steps }: HandlerContext) {
  const s = (steps || {}) as ShapeSteps;
  const folders: NodeRow[] = s.allFolders || [];

  const byId: Record<string, NodeRow> = {};
  for (const folder of folders) {
    const f = folder || ({} as NodeRow);
    const fid = idOf(f);
    if (fid) byId[fid] = f;
  }

  /**
   * Human-readable slash path of a folder, built from displayNames.
   *
   * Unlike `folderChain` this does NOT resolve the `'root'` sentinel — the walk simply stops
   * when it reaches it, so the root folder contributes no segment to the path.
   */
  function folderPath(startId: string | null | undefined): string {
    const names: string[] = [];
    let cur = String(startId || '');
    let depth = 0;
    while (cur && UUID.test(cur) && byId[cur] && depth < MAX_DEPTH) {
      names.push(String(byId[cur].displayName || 'Untitled'));
      cur = (byId[cur].parentId || '') as string;
      depth++;
    }
    const out: string[] = [];
    for (let b = names.length - 1; b >= 0; b--) out.push(names[b]);
    return out.join('/');
  }

  const vw: Viewer = (s.gate && s.gate.viewer) || {};
  const rows: NodeRow[] = s.query || [];

  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const r = row || ({} as NodeRow);
    const id = idOf(r);
    if (!id) continue;

    const t = r.nodeType || 'file';
    const size = typeof r.size === 'number' ? r.size : r.size != null ? Number(r.size) : null;
    const created =
      typeof r.createdMs === 'number' ? r.createdMs : r.createdMs != null ? Number(r.createdMs) : 0;
    const url = (r.url || null) as string | null;
    const grants = parseGrants(r.grantsJson);

    // A folder is its own chain link; a leaf inherits from its parent chain plus a synthetic
    // link for itself (leaves carry no grants of their own).
    let ch: ChainNode[];
    if (t === 'folder') {
      ch = folderChain(folders, id);
    } else {
      ch = folderChain(folders, r.parentId);
      ch.push({ id: id, ownerId: r.ownerId || null, grants: [], mode: 'inheriting' });
    }
    if (evalAccess(ch, vw) === 'none') continue;

    const sp = (r.storage_path || '') as string;
    const mi = sp.indexOf(SPM);
    const nonFolderPath =
      mi >= 0
        ? sp.slice(mi + SPM.length)
        : url && url.indexOf(CONTENT) === 0
          ? url.slice(CONTENT.length)
          : null;

    out.push({
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
    });
  }

  // The singleton root record: its id, and whether it is shared with `anyone` (i.e. "Public").
  let rootRec: NodeRow | null = null;
  for (const folder of folders) {
    if ((folder || ({} as NodeRow)).nodeType === 'root') {
      rootRec = folder;
      break;
    }
  }

  let rootRecordId: string | null = null;
  let rootPublic = false;
  if (rootRec) {
    rootRecordId = idOf(rootRec);
    const rg = parseGrants(rootRec.grantsJson);
    for (const grant of rg) {
      if ((grant || ({} as Grant)).principalId === ANYONE_PRINCIPAL) {
        rootPublic = true;
        break;
      }
    }
  }

  return { nodes: out, rootMeta: { id: rootRecordId, public: rootPublic } };
}
