import type { HandlerContext } from 'bffless/handlers';

/** The PATCH body: either field may be absent — presence, not truthiness, decides what gets saved. */
interface MetaBody {
  id?: unknown;
  title?: unknown;
  description?: unknown;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function handler({ request }: HandlerContext) {
  const b: MetaBody = ((request && request.body) as MetaBody) || {};
  const id = String(b.id || '');

  const hasTitle = typeof b.title === 'string';
  const hasDescription = typeof b.description === 'string';

  const titleRaw = hasTitle ? String(b.title).replace(/^\s+|\s+$/g, '') : '';
  const title = hasTitle ? (titleRaw ? titleRaw.slice(0, 200) : null) : null;
  const description = hasDescription
    ? String(b.description)
      ? String(b.description).slice(0, 2000)
      : null
    : null;

  const idOk = !!id && UUID.test(id);
  const hasField = hasTitle || hasDescription;

  return {
    id: id,
    idOk: idOk,
    hasTitle: hasTitle,
    hasDescription: hasDescription,
    title: title,
    description: description,
    hasField: hasField,
  };
}
