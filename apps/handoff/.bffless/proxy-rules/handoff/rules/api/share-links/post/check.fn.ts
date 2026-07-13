/**
 * Only the folder's owner (or an admin) may mint a share link for it.
 *
 * `allowed` / `denied` are returned as separate plain booleans because a step `condition` can
 * only reference a simple path — it cannot express `!steps.check.allowed`.
 */
import type { HandlerContext } from 'bffless/handlers';

interface FolderRecord {
  ownerId?: string | null;
}

export default function handler({ user, steps }: HandlerContext) {
  const allSteps = (steps || {}) as { folder?: FolderRecord };

  const folder = (steps && allSteps.folder) || ({} as FolderRecord);
  const uid = (user && (user.id as string)) || null;
  const isAdmin = !!user && user.role === 'admin';
  const isOwner = !!uid && folder.ownerId === uid;
  const allowed = isAdmin || isOwner;

  return { allowed: allowed, denied: !allowed };
}
