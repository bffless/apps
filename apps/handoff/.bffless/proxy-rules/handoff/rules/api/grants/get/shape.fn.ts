/**
 * Shape the grants list for a folder: normalise the stored `grantsJson` blob into the
 * `{ principalId, principalEmail, level }` triples the UI renders.
 *
 * Anything that isn't a well-formed array of grants with a principalId is dropped, and any
 * level other than 'edit' collapses to 'view'.
 */
import type { HandlerContext } from 'bffless/handlers';

interface StoredGrant {
  principalId?: string;
  principalEmail?: string | null;
  level?: string;
}

interface FolderRecord {
  grantsJson?: unknown;
}

export default function handler({ steps }: HandlerContext) {
  const allSteps = (steps || {}) as { folder?: FolderRecord };
  const folder = (steps && allSteps.folder) || ({} as FolderRecord);

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
        level: g.level === 'edit' ? 'edit' : 'view',
      });
    }
  }

  return { grants: out };
}
