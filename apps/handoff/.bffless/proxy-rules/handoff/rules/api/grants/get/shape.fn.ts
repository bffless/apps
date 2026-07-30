/**
 * Shape the grants list for a folder: normalise the stored `grantsJson` blob into the
 * `{ principalId, principalEmail, principalType, principalName, level }` tuples the UI renders.
 *
 * Anything that isn't a well-formed array of grants with a principalId is dropped, and any
 * level other than 'edit' collapses to 'view'.
 *
 * `principalType`/`principalName` are echoed verbatim from storage (display metadata only,
 * group grants spec 2026-07-29): a legacy stored grant with no `principalType` shapes with it
 * absent, NOT rewritten to `'user'` — only `'group'` is ever a real value.
 *
 * SECURITY (issue #266): a folder's grants list is itself sensitive (principal emails, group
 * names) — this is a read, but not a public one. Gated identically to the write path
 * (`../post/merge.fn.ts`): only the folder's direct owner or an admin may list it. No chain
 * walking — same as POST, consistency with the write path is the requirement, not
 * inherited/effective access. A denied caller gets `denied: true` and an empty list, which the
 * 403 response step is conditioned on; `allowed` gates the 200.
 */
import type { HandlerContext } from 'bffless/handlers';

interface StoredGrant {
  principalId?: string;
  principalEmail?: string | null;
  principalType?: string;
  principalName?: string | null;
  level?: string;
}

interface FolderRecord {
  ownerId?: string | null;
  grantsJson?: unknown;
}

export default function handler({ user, steps }: HandlerContext) {
  const allSteps = (steps || {}) as { folder?: FolderRecord };
  const folder = (steps && allSteps.folder) || ({} as FolderRecord);

  const uid = (user && (user.id as string)) || null;
  const isAdmin = !!user && user.role === 'admin';
  const isOwner = !!uid && folder.ownerId === uid;

  if (!isAdmin && !isOwner) {
    return { allowed: false, denied: true, grants: [] as StoredGrant[] };
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

  const grants = existing as StoredGrant[];
  const out: StoredGrant[] = [];
  for (let i = 0; i < grants.length; i++) {
    const g = grants[i] || ({} as StoredGrant);
    if (g.principalId) {
      out.push({
        principalId: g.principalId,
        principalEmail: g.principalEmail || null,
        principalType: g.principalType === 'group' ? 'group' : undefined,
        principalName: g.principalName || null,
        level: g.level === 'edit' ? 'edit' : 'view',
      });
    }
  }

  return { allowed: true, denied: false, grants: out };
}
