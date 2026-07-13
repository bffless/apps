/**
 * Report whether a share-link token is still usable, and which folder it scopes to.
 *
 * Same validity test as the claim handler (present, not revoked, not expired) but read-only —
 * this one issues no cookie. A missing `link` step (bad or unknown token) leaves `folderId`
 * null, so `valid` is false: deliberately not a 404, so a probe can't distinguish "no such
 * token" from "revoked".
 */
import type { HandlerContext } from 'bffless/handlers';

interface ShareLinkRecord {
  folderId?: string | null;
  revoked?: boolean | string;
  expiresMs?: number | string | null;
}

export default function handler({ steps }: HandlerContext) {
  const allSteps = (steps || {}) as { link?: ShareLinkRecord };

  let l: ShareLinkRecord = (steps && allSteps.link) || ({} as ShareLinkRecord);
  if (l == null || typeof l !== 'object') l = {} as ShareLinkRecord;

  const folderId = l.folderId || null;
  const revoked = l.revoked === true || l.revoked === 'true';
  const exp = l.expiresMs != null ? Number(l.expiresMs) : null;
  const expired = exp != null && !isNaN(exp) ? Date.now() > exp : false;
  const valid = !!folderId && !revoked && !expired;

  return { result: { valid: valid, folderId: valid ? folderId : null } };
}
