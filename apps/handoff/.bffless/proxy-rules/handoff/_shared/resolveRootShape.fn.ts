/**
 * Last step of the resolve-root group: turn the `'root'` sentinel into the singleton root
 * record's real UUID, so every id-keyed step downstream can just use `effectiveFolderId`.
 *
 * Shared verbatim by all five root-aware rules — it was five identical copies before.
 *
 * A non-root request passes its folderId straight through. A root request reads the record the
 * `rootRecord` query found, falling back to the one `rootCreate` just minted (that step only runs
 * for an admin, so for a non-admin with no root record yet both are empty and `effectiveFolderId`
 * comes back null — which is exactly what the id-keyed steps are conditioned on, so they skip
 * rather than querying a UUID column with the literal string 'root' and 500ing).
 */
import type { HandlerContext } from 'bffless/handlers';

interface NodeRecord {
  id?: string;
  recordId?: string;
  record_id?: string;
  ownerId?: string | null;
}

export interface ResolveRootShape {
  effectiveFolderId: string | null;
  rootOwnerId: string | null;
}

export default function handler({ user, steps }: HandlerContext): ResolveRootShape {
  const allSteps = (steps || {}) as {
    resolveRootPre?: { isRoot?: boolean; folderId?: string };
    rootRecord?: NodeRecord[];
    rootCreate?: NodeRecord | null;
  };

  const pre = allSteps.resolveRootPre || {};
  if (!pre.isRoot) {
    return { effectiveFolderId: pre.folderId ?? null, rootOwnerId: null };
  }

  const rows = allSteps.rootRecord || [];
  const record: NodeRecord | null = rows.length ? rows[0] : allSteps.rootCreate || null;

  const effectiveFolderId = record ? record.id || record.recordId || record.record_id || null : null;
  const rootOwnerId = record ? record.ownerId || (user && (user.id as string)) || null : null;

  return { effectiveFolderId, rootOwnerId };
}
