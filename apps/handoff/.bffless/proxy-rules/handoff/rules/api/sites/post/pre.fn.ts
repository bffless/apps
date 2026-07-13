import type { HandlerContext } from 'bffless/handlers';

/** POST /api/sites body — the client sends the parent and the new site's name. */
interface CreateSiteBody {
  parentId?: unknown;
  name?: unknown;
}

/**
 * Normalize the create-site body into the shape the sibling-uniqueness check needs.
 *
 * `check` is what gates the sibling `data_query` — a missing parentId or name would
 * otherwise resolve to null and eq-match nothing (issue #225).
 */
export default function handler({ request }: HandlerContext) {
  const b: CreateSiteBody = ((request && request.body) as CreateSiteBody) || {};
  const pid = b.parentId != null ? String(b.parentId) : '';
  const name = b.name != null ? String(b.name) : '';
  return { parentId: pid, name: name, check: pid !== '' && name !== '' };
}
