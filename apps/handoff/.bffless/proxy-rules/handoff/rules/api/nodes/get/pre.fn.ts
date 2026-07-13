import type { HandlerContext } from 'bffless/handlers';

/** Parent ids are record UUIDs, apart from the synthetic 'root' sentinel. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Normalize `?parentId=`, defaulting to root.
 *
 * The listing query consumes `steps.pre.parentId` (not `request.query.parentId`) so a bare
 * GET /api/nodes with no query string lists root instead of eq-matching null (issue #225).
 */
export default function handler({ request }: HandlerContext) {
  let pid = String((request && request.query && request.query.parentId) || 'root');
  if (!pid) pid = 'root';
  const isRoot = pid === 'root';
  const ok = isRoot || UUID.test(pid);
  return { parentId: pid, isRoot: isRoot, parentOk: ok };
}
