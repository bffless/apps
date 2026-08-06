import type { HandlerContext } from 'bffless/handlers';
import type { NodeRow } from '../../../../../_shared/acl';
import { decideWrite, viewerFrom } from '../../../../../_shared/writeAccess';

/** What the `pre` step handed us: the normalized parentId/name and whether a check is warranted. */
interface PreStep {
  parentId?: string;
  name?: string;
  check?: boolean;
}

/** A sibling row from the `data_query` step — name lives under whichever column the row carries. */
interface SiblingRow {
  displayName?: string | null;
  original_name?: string | null;
  filename?: string | null;
}

interface Steps {
  pre?: PreStep;
  sibling?: SiblingRow[];
  allFolders?: NodeRow[];
}

export default function handler({ user, request, steps, utils }: HandlerContext) {
  const s = (steps || {}) as Steps;
  const pre: PreStep = s.pre || {};

  // Access first: a caller who cannot write here never learns whether the name is taken.
  const decision = decideWrite({
    folders: s.allFolders || [],
    parentId: pre.parentId || '',
    viewer: viewerFrom({ user: user, request: request, utils: utils }),
  });
  if (!decision.allow) {
    return { ok: false, collision: false, deny401: decision.deny401, deny403: decision.deny403 };
  }

  if (!pre.check) return { ok: true, collision: false, deny401: false, deny403: false };

  // A name is a path segment under verbatim keys, so it collides with ANY
  // same-named sibling regardless of owner — root included (issue #225).
  const rows: SiblingRow[] = s.sibling || [];
  let hit = false;
  for (let i = 0; i < rows.length; i++) {
    const r: SiblingRow = rows[i] || {};
    const nm = r.displayName != null ? r.displayName : r.original_name != null ? r.original_name : r.filename;
    if (nm === pre.name) {
      hit = true;
      break;
    }
  }
  return { ok: !hit, collision: hit, deny401: false, deny403: false };
}
