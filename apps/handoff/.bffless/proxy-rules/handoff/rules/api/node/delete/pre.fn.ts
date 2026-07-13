import type { HandlerContext } from 'bffless/handlers';

/** Node ids are record UUIDs — anything else short-circuits the pipeline's `idOk`-gated steps. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function handler({ request }: HandlerContext) {
  const id = String((request && request.query && request.query.id) || '');
  const ok = UUID_RE.test(id);
  return { id: id, idOk: ok };
}
