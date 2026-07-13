/**
 * Shape the freshly-created share link for the response.
 *
 * The token IS the new record's id (whichever casing `data_create` returned it under), so the
 * share URL is derived from it rather than stored.
 */
import type { HandlerContext } from 'bffless/handlers';

interface CreatedRecord {
  id?: string;
  recordId?: string;
  record_id?: string;
}

interface CreateBody {
  folderId?: string | null;
  expiresMs?: number | string | null;
}

export default function handler({ request, steps }: HandlerContext) {
  const allSteps = (steps || {}) as { create?: CreatedRecord };

  const c = (steps && allSteps.create) || ({} as CreatedRecord);
  const body = ((request && request.body) || {}) as CreateBody;

  const token = c.id || c.recordId || c.record_id || null;
  const exp = body.expiresMs != null ? Number(body.expiresMs) : null;

  return {
    link: {
      token: token,
      folderId: body.folderId || null,
      expiresAt: exp != null && !isNaN(exp) ? exp : null,
      revoked: false,
      url: token ? '/s/' + token : null,
    },
  };
}
