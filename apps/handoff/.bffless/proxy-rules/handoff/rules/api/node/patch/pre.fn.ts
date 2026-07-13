import type { HandlerContext } from 'bffless/handlers';

/** The PATCH body: `mode` and `feedExcluded` are both optional; at least one must be present. */
interface ModeBody {
  id?: unknown;
  mode?: unknown;
  feedExcluded?: unknown;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function handler({ request, user }: HandlerContext) {
  const b: ModeBody = ((request && request.body) as ModeBody) || {};
  const id = String(b.id || '');

  const mode = b.mode === 'restricted' ? 'restricted' : b.mode === 'inheriting' ? 'inheriting' : '';
  const hasMode = !!mode;

  const hasFeedExcluded = typeof b.feedExcluded === 'boolean';
  const feedExcluded = b.feedExcluded === true;

  const valid = !!id && UUID.test(id) && (hasMode || hasFeedExcluded);

  return {
    id: id,
    mode: mode,
    hasMode: hasMode,
    hasFeedExcluded: hasFeedExcluded,
    feedExcluded: feedExcluded,
    valid: valid,
    isAdmin: !!user && user.role === 'admin',
    uid: (user && user.id) || null,
  };
}
