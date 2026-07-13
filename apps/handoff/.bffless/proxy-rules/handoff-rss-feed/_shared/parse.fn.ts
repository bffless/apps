/**
 * Parse a feed request into a folder path + optional share-link token.
 *
 * Shared by BOTH feed rules — `/feed/<path>.xml` and the root `/feed.xml` — which is why the
 * root case is derived rather than hard-coded: no `/feed/` segment in the path means root.
 */
import type { HandlerContext } from 'bffless/handlers';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ParseResult {
  path: string;
  segments: string[];
  isRoot: boolean;
  bad: boolean;
  token: string;
  hasToken: boolean;
}

export default function handler({ request }: HandlerContext): ParseResult {
  let path = (request && request.path) || '';
  const queryStart = path.indexOf('?');
  if (queryStart >= 0) path = path.slice(0, queryStart);

  // request.path is the internal rewritten path (a deployment prefix + the app route). The
  // deployment prefix contains no '/feed/' segment, so the FIRST '/feed/' marks the folder
  // feed route; without it the request is the root feed ('/feed.xml', which has no '/feed/').
  const marker = '/feed/';
  const markerAt = path.indexOf(marker);
  let rest = '';
  if (markerAt >= 0) {
    rest = path.slice(markerAt + marker.length);
    if (rest.slice(-4) === '.xml') rest = rest.slice(0, -4);
  }

  const segments: string[] = [];
  let bad = false;
  for (let raw of rest.split('/')) {
    if (!raw) continue;
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Malformed escape — keep the segment raw rather than 500ing.
    }
    if (raw === '.' || raw === '..') {
      bad = true;
      break;
    }
    segments.push(raw);
  }

  // A private feed carries a Share Link ?token= (ADR-0008). Surface it, and whether it's a
  // well-formed UUID, so the link lookup (`data_query` on steps.parse.hasToken) can run.
  const query = (request && request.query) || {};
  const token = String(query.token || '');

  return {
    path: segments.join('/'),
    segments,
    isRoot: segments.length === 0,
    bad,
    token,
    hasToken: UUID_RE.test(token),
  };
}
