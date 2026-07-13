/**
 * First step of the resolve-root group: read the requested folderId and decide whether it names
 * the synthetic `'root'` sentinel.
 *
 * Shared verbatim by all five root-aware rules (grants POST/GET, grants/revoke POST, share-links
 * POST/GET) — it was five identical copies before. `isRoot` and `isAdmin` are precomputed here
 * because a BFFless step `condition` can only reference a simple path: it cannot express
 * `a && !b`, so every branch a later step needs has to arrive as a plain boolean.
 */
import type { HandlerContext } from 'bffless/handlers';

export interface ResolveRootPre {
  folderId: string;
  isRoot: boolean;
  isAdmin: boolean;
}

export default function handler({ request, user }: HandlerContext): ResolveRootPre {
  const body = ((request && request.body) || {}) as Record<string, unknown>;
  const query = ((request && request.query) || {}) as Record<string, unknown>;

  const folderId = String(body.folderId || query.folderId || '');

  return {
    folderId,
    isRoot: folderId === 'root',
    isAdmin: !!user && user.role === 'admin',
  };
}
