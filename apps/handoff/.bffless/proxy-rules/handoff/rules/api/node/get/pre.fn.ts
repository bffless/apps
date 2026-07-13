import type { HandlerContext } from 'bffless/handlers';

/** Node ids are record UUIDs; anything else must not reach the `data_query` step. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Normalize `?id=` and report whether it's a well-formed record id (`idOk` gates the query). */
export default function handler({ request }: HandlerContext) {
  const id = String((request && request.query && request.query.id) || '');
  const ok = UUID.test(id);
  return { id: id, idOk: ok };
}
