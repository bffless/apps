/**
 * Validate a share-link token and, if it's good, mint the signed `hf_s` share cookie (ADR-0002).
 *
 * The cookie payload is a base64url `{ s: <folderId>, exp }` blob followed by `.` + an HMAC of
 * that blob (`utils.sign`), so the ACL gate can trust the folder scope without a DB lookup. It's
 * View-only, folder-scoped, and lives 30 minutes (1800000 ms payload exp / Max-Age=1800 s).
 *
 * A missing `link` step (bad or unknown token) leaves `folderId` null, so `valid` is false and
 * the 200-with-`valid:false` branch answers — deliberately not a 404, so a probe can't
 * distinguish "no such token" from "revoked".
 */
import type { HandlerContext } from 'bffless/handlers';

interface ShareLinkRecord {
  folderId?: string | null;
  revoked?: boolean | string;
  expiresMs?: number | string | null;
}

export default function handler({ steps, utils }: HandlerContext) {
  const allSteps = (steps || {}) as { link?: ShareLinkRecord };

  let l: ShareLinkRecord = (steps && allSteps.link) || ({} as ShareLinkRecord);
  if (l == null || typeof l !== 'object') l = {} as ShareLinkRecord;

  const folderId = l.folderId || null;
  const revoked = l.revoked === true || l.revoked === 'true';
  const exp = l.expiresMs != null ? Number(l.expiresMs) : null;
  const expired = exp != null && !isNaN(exp) ? Date.now() > exp : false;
  const valid = !!folderId && !revoked && !expired;

  let setCookie = '';
  if (valid) {
    const payload = utils.base64urlEncode(
      JSON.stringify({ s: String(folderId), exp: Date.now() + 1800000 }),
    );
    setCookie =
      'hf_s=' +
      payload +
      '.' +
      utils.sign(payload) +
      '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800';
  }

  return {
    valid: valid,
    invalid: !valid,
    folderId: valid ? folderId : null,
    setCookie: setCookie,
  };
}
