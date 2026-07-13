import type { HandlerContext } from 'bffless/handlers';

/** POST /api/nodes body — registering an already-uploaded file under a parent. */
interface RegisterNodeBody {
  parentId?: unknown;
  displayName?: unknown;
}

/**
 * Normalize the register-node body into the shape the sibling-uniqueness check needs.
 *
 * `check` is what gates the sibling `data_query` — a missing parentId or name would
 * otherwise resolve to null and eq-match nothing (issue #225).
 */
export default function handler({ request }: HandlerContext) {
  const b: RegisterNodeBody = ((request && request.body) as RegisterNodeBody) || {};
  const pid = b.parentId != null ? String(b.parentId) : '';
  const name = b.displayName != null ? String(b.displayName) : '';
  return { parentId: pid, name: name, check: pid !== '' && name !== '' };
}
