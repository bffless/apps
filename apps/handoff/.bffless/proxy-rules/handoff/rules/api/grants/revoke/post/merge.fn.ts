/**
 * Remove one grant from a folder, returning the whole rewritten grants array for `save`.
 *
 * Only the folder's owner (or an admin) may change grants; a denied caller gets an empty list
 * plus `denied: true`, which the 403 response step is conditioned on. `canSave` is false when
 * root couldn't be resolved (see resolveRootShape) so the `data_update` step skips rather than
 * writing to a null recordId.
 *
 * Revoking the reserved `anyone` principal is how a folder stops being public (ADR-0005) — it
 * takes the same path as any other principal here.
 */
import type { HandlerContext } from 'bffless/handlers';

interface StoredGrant {
  principalId?: string;
  principalEmail?: string | null;
  level?: string;
}

interface FolderRecord {
  ownerId?: string | null;
  grantsJson?: unknown;
}

interface RevokeBody {
  principalId?: string;
}

export default function handler({ user, request, steps }: HandlerContext) {
  const allSteps = (steps || {}) as {
    folder?: FolderRecord;
    resolveRootShape?: { effectiveFolderId?: string | null };
  };

  const folder = (steps && allSteps.folder) || ({} as FolderRecord);
  const body = ((request && request.body) || {}) as RevokeBody;
  const uid = (user && (user.id as string)) || null;
  const isAdmin = !!user && user.role === 'admin';
  const isOwner = !!uid && folder.ownerId === uid;
  const eff = (steps && allSteps.resolveRootShape && allSteps.resolveRootShape.effectiveFolderId) || null;

  if (!isAdmin && !isOwner) {
    return { allowed: false, denied: true, grants: [] as StoredGrant[], canSave: false };
  }

  let existing: unknown = folder.grantsJson;
  if (typeof existing === 'string') {
    try {
      existing = JSON.parse(existing);
    } catch {
      existing = [];
    }
  }
  if (!existing || Object.prototype.toString.call(existing) !== '[object Array]') {
    existing = [];
  }

  const current = existing as StoredGrant[];

  const pid = String(body.principalId || '').trim();

  const out: StoredGrant[] = [];
  for (let i = 0; i < current.length; i++) {
    const g = current[i] || ({} as StoredGrant);
    if (g.principalId && g.principalId !== pid) {
      out.push({
        principalId: g.principalId,
        principalEmail: g.principalEmail || null,
        level: g.level === 'edit' ? 'edit' : 'view',
      });
    }
  }

  return { allowed: true, denied: false, grants: out, canSave: !!eff };
}
