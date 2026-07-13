import type { HandlerContext } from 'bffless/handlers';

export default function handler({ request, deployment }: HandlerContext) {
  const p = (request && request.path) || '';
  const marker = '/api/uploads/content/';
  const i = p.indexOf(marker);
  let rest = i >= 0 ? p.slice(i + marker.length) : '';

  const q = rest.indexOf('?');
  if (q >= 0) rest = rest.slice(0, q);

  const segs = rest.split('/');
  let bad = false;
  for (let s = 0; s < segs.length; s++) {
    try {
      segs[s] = decodeURIComponent(segs[s]);
    } catch {
      /* malformed escape - keep raw */
    }
    // Reject a traversal segment — a decoded `.` or `..` — before it reaches `fullKey` (which the
    // gate authorizes by Site-prefix match) or `rest` (which the serve step turns into a storage
    // key). The sibling /api/resolve parser guards the same way; keep the two in step. See #238.
    if (segs[s] === '.' || segs[s] === '..') {
      bad = true;
      break;
    }
  }
  rest = bad ? '' : segs.join('/');

  // The storage prefix is derived from the deployment, not hard-coded, so the rule set stays
  // portable across projects.
  const owner = (deployment && deployment.owner) || '';
  const repo = (deployment && deployment.repo) || '';

  const fullKey = !bad && rest && owner && repo ? owner + '/' + repo + '/uploads/content/' + rest : '';

  return { rest: rest, fullKey: fullKey, hasKey: !!fullKey, bad: bad };
}
