import type { HandlerContext } from 'bffless/handlers';

/** POST /api/sites body — `path` is the site's content prefix, `entry` its index document. */
interface CreateSiteBody {
  path?: unknown;
  entry?: unknown;
}

/**
 * Derive the site's storage prefix and entry URL from the request + the deployment identity.
 *
 * The prefix is built from `deployment.owner` / `deployment.repo` rather than a literal so the
 * rule set stays portable across projects — never hard-code the path.
 */
export default function handler({ request, deployment }: HandlerContext) {
  const body: CreateSiteBody = ((request && request.body) as CreateSiteBody) || {};
  const path = String(body.path || '');
  const entry = String(body.entry || 'index.html');
  const owner = (deployment && deployment.owner) || '';
  const repo = (deployment && deployment.repo) || '';
  const storagePrefix = path && owner && repo ? owner + '/' + repo + '/uploads/content/' + path : '';
  const url = path ? '/api/uploads/content/' + path + '/' + entry : null;
  return { path: path, entry: entry, storagePrefix: storagePrefix, url: url };
}
