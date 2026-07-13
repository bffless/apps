/**
 * Only the link's creator (or an admin) may revoke it.
 *
 * A missing/unknown link has no `folderId`, so `allowed` is false and the request is denied
 * rather than silently succeeding on nothing. `allowed` / `denied` are separate plain booleans
 * because a step `condition` can only reference a simple path — it cannot express `!allowed`.
 */
import type { HandlerContext } from 'bffless/handlers';

interface ShareLinkRecord {
  folderId?: string | null;
  createdBy?: string | null;
}

export default function handler({ user, steps }: HandlerContext) {
  const allSteps = (steps || {}) as { link?: ShareLinkRecord };

  const l = (steps && allSteps.link) || ({} as ShareLinkRecord);
  const uid = (user && (user.id as string)) || null;
  const isAdmin = !!user && user.role === 'admin';
  const isCreator = !!uid && l.createdBy === uid;
  const allowed = !!l.folderId && (isAdmin || isCreator);

  return { allowed: allowed, denied: !allowed };
}
