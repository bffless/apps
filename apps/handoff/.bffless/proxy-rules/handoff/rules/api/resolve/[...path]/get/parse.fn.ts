import type { HandlerContext } from 'bffless/handlers';

export default function handler({ request, deployment }: HandlerContext) {
  const p = (request && request.path) || '';
  const marker = '/api/resolve/';
  const i = p.indexOf(marker);
  let rest = i >= 0 ? p.slice(i + marker.length) : '';

  const q = rest.indexOf('?');
  if (q >= 0) rest = rest.slice(0, q);

  const rawSegs = rest.split('/');
  const segs: string[] = [];
  let bad = false;

  for (let s = 0; s < rawSegs.length; s++) {
    let sg = rawSegs[s];
    if (!sg) continue;
    try {
      sg = decodeURIComponent(sg);
    } catch {
      /* malformed escape - keep raw */
    }
    if (sg === '.' || sg === '..') {
      bad = true;
      break;
    }
    segs.push(sg);
  }

  const path = segs.join('/');

  // The storage prefix is derived from the deployment, not hard-coded, so the rule set stays
  // portable across projects.
  const owner = (deployment && deployment.owner) || '';
  const repo = (deployment && deployment.repo) || '';

  const hasPath = !bad && segs.length > 0 && !!owner && !!repo;
  const fullKey = hasPath ? owner + '/' + repo + '/uploads/content/' + path : '';

  return { path: path, segments: segs, fullKey: fullKey, hasPath: hasPath };
}
