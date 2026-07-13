import type { HandlerContext } from 'bffless/handlers';

/** The prepare body: the target folder and the filename we're about to mint a presigned PUT for. */
interface PrepareBody {
  parentId?: unknown;
  filename?: unknown;
}

export default function handler({ request }: HandlerContext) {
  const b: PrepareBody = ((request && request.body) as PrepareBody) || {};
  const pid = b.parentId != null ? String(b.parentId) : '';
  const name = b.filename != null ? String(b.filename) : '';
  return { parentId: pid, name: name, check: pid !== '' && name !== '' };
}
