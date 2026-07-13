import type { HandlerContext } from 'bffless/handlers';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function handler({ request }: HandlerContext) {
  const p = (request && request.path) || '';
  const marker = '/r/';
  const i = p.indexOf(marker);
  let rest = i >= 0 ? p.slice(i + marker.length) : '';

  const qm = rest.indexOf('?');
  if (qm >= 0) rest = rest.slice(0, qm);

  const slash = rest.indexOf('/');
  let fileId = slash >= 0 ? rest.slice(0, slash) : rest;
  try {
    fileId = decodeURIComponent(fileId);
  } catch {
    /* malformed escape - keep raw */
  }

  const query = (request && request.query) || {};
  const token = String(query.token || '');

  const hasBoth = UUID.test(fileId) && UUID.test(token);

  return { fileId: fileId, token: token, hasBoth: hasBoth };
}
