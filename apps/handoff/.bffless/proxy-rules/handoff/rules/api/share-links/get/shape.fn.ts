/**
 * Shape the share-link rows for a folder into the list the UI renders.
 *
 * The token IS the record id (whichever casing the query returned it under), so the share URL
 * is derived from it rather than stored. A row with no id is unusable as a link and is dropped.
 */
import type { HandlerContext } from 'bffless/handlers';

interface ShareLinkRow {
  id?: string;
  recordId?: string;
  record_id?: string;
  folderId?: string | null;
  revoked?: boolean | string;
  expiresMs?: number | string | null;
  createdMs?: number | string | null;
}

export default function handler({ steps }: HandlerContext) {
  const allSteps = (steps || {}) as { rows?: ShareLinkRow[] };
  const rows = (steps && allSteps.rows) || [];

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i] || ({} as ShareLinkRow);
    const token = l.id || l.recordId || l.record_id || null;
    if (!token) continue;

    const revoked = l.revoked === true || l.revoked === 'true';
    const exp = l.expiresMs != null ? Number(l.expiresMs) : null;

    out.push({
      token: token,
      folderId: l.folderId || null,
      expiresAt: exp != null && !isNaN(exp) ? exp : null,
      revoked: revoked,
      url: '/s/' + token,
      createdAt: l.createdMs != null ? Number(l.createdMs) : 0,
    });
  }

  return { links: out };
}
