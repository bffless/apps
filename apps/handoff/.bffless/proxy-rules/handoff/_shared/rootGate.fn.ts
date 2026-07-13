/**
 * Decide whether the singleton root record needs minting on this request.
 *
 * Shared by the two rules that can create root on demand — POST /api/grants and
 * POST /api/share-links — which carried byte-identical copies of this before.
 *
 * `shouldCreate` is precomputed as a single boolean because a BFFless step `condition` can only
 * reference a simple path — it cannot express `isRoot && isAdmin && !exists`.
 *
 * `rootRecord` is a data_query, so it normally arrives as an array; the non-array branch is a
 * defensive fallback for a runtime that hands back a bare record.
 */
import type { HandlerContext } from 'bffless/handlers';

export default function handler({ steps }: HandlerContext) {
  const allSteps = (steps || {}) as {
    resolveRootPre?: { isRoot?: boolean; isAdmin?: boolean };
    rootRecord?: unknown;
  };

  const pre = (steps && allSteps.resolveRootPre) || {};
  const rows = steps && allSteps.rootRecord;

  let exists = false;
  if (Object.prototype.toString.call(rows) === '[object Array]') {
    exists = (rows as unknown[]).length > 0;
  } else if (rows) {
    exists = true;
  }

  return { shouldCreate: pre.isRoot === true && pre.isAdmin === true && exists === false };
}
