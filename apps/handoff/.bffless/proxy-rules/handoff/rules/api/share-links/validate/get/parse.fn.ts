/**
 * Read the share-link token off the query string.
 *
 * The token IS the share-link record's UUID, so `hasToken` is a shape check, not just a
 * presence check — the `link` data_query is keyed on it and a non-UUID would 500 the
 * recordId lookup. It's precomputed as a plain boolean because a step `condition` can only
 * reference a simple path.
 */
import type { HandlerContext } from 'bffless/handlers';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function handler({ request }: HandlerContext) {
  const q = ((request && request.query) || {}) as { token?: string };
  const token = String(q.token || '');
  const isUuid = UUID_RE.test(token);

  return { token: token, hasToken: isUuid };
}
