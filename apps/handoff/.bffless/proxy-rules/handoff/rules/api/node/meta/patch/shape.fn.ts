import type { HandlerContext } from 'bffless/handlers';

/** The re-read row from the `final` data_query step (only present when a save actually ran). */
interface FinalRow {
  title?: unknown;
  description?: unknown;
}

interface Steps {
  final?: FinalRow;
  pre?: { id?: string };
}

export default function handler({ steps }: HandlerContext) {
  const s = steps as Steps;
  let r: FinalRow = (s && s.final) || {};
  if (r == null || typeof r !== 'object') r = {};

  const id = (s && s.pre && s.pre.id) || '';
  const t = r.title != null && String(r.title) !== '' ? String(r.title) : null;
  const de = r.description != null && String(r.description) !== '' ? String(r.description) : null;

  return { body: JSON.stringify({ id: id, title: t, description: de }) };
}
