/**
 * Add/update one grant on a folder, returning the whole rewritten grants array for `save`.
 *
 * Only the folder's owner (or an admin) may change grants; a denied caller gets an empty list
 * plus `denied: true`, which the 403 response step is conditioned on. `canSave` is false when
 * root couldn't be resolved (see resolveRootShape) so the `data_update` step skips rather than
 * writing to a null recordId.
 *
 * SECURITY: the reserved `anyone` principal — the grant that makes a folder public (ADR-0005) —
 * is capped at `level: 'view'` and carries no `principalEmail`. Publicness can never escalate to
 * edit, and there is no person behind it to name. Do not relax this.
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

interface GrantBody {
  principalId?: string;
  principalEmail?: string;
  level?: string;
}

export default function handler({ user, request, steps }: HandlerContext) {
  const allSteps = (steps || {}) as {
    folder?: FolderRecord;
    resolveRootShape?: { effectiveFolderId?: string | null };
  };

  const folder = (steps && allSteps.folder) || ({} as FolderRecord);
  const body = ((request && request.body) || {}) as GrantBody;
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
  let level = body.level === 'edit' ? 'edit' : 'view';
  let email: string | null = body.principalEmail ? String(body.principalEmail) : null;
  if (pid === 'anyone') {
    level = 'view';
    email = null;
  }

  const out: StoredGrant[] = [];
  let replaced = false;
  for (let i = 0; i < current.length; i++) {
    const g = current[i] || ({} as StoredGrant);
    if (g.principalId === pid && pid) {
      out.push({
        principalId: pid,
        principalEmail: pid === 'anyone' ? null : email || g.principalEmail || null,
        level: level,
      });
      replaced = true;
    } else if (g.principalId) {
      out.push({
        principalId: g.principalId,
        principalEmail: g.principalEmail || null,
        level: g.level === 'edit' ? 'edit' : 'view',
      });
    }
  }

  if (pid && !replaced) {
    out.push({ principalId: pid, principalEmail: email, level: level });
  }

  return { allowed: true, denied: false, grants: out, canSave: !!eff };
}
