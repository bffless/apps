import type { HandlerContext } from 'bffless/handlers';

export default function handler({ request, deployment }: HandlerContext) {
  const p = (request && request.path) || '';
  const marker = '/api/uploads/content/';
  const i = p.indexOf(marker);
  let rest = i >= 0 ? p.slice(i + marker.length) : '';

  const q = rest.indexOf('?');
  if (q >= 0) rest = rest.slice(0, q);

  const segs = rest.split('/');
  for (let s = 0; s < segs.length; s++) {
    try {
      segs[s] = decodeURIComponent(segs[s]);
    } catch {
      /* malformed escape - keep raw */
    }
  }
  rest = segs.join('/');

  // The storage prefix is derived from the deployment, not hard-coded, so the rule set stays
  // portable across projects.
  const owner = (deployment && deployment.owner) || '';
  const repo = (deployment && deployment.repo) || '';

  const fullKey = rest && owner && repo ? owner + '/' + repo + '/uploads/content/' + rest : '';

  return { rest: rest, fullKey: fullKey, hasKey: !!fullKey };
}
