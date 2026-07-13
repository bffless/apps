import type { HandlerContext } from 'bffless/handlers';

/** What the `pre` step handed us: the normalized parentId/name and whether a check is warranted. */
interface PreStep {
  parentId?: string;
  name?: string;
  check?: boolean;
}

/** A sibling row from the `data_query` step — the name lives under whichever column the row carries. */
interface SiblingRow {
  displayName?: string | null;
  original_name?: string | null;
  filename?: string | null;
}

interface Steps {
  pre?: PreStep;
  sibling?: SiblingRow[];
}

export default function handler({ steps }: HandlerContext) {
  const s = steps as Steps;
  const pre: PreStep = (s && s.pre) || {};
  if (!pre.check) return { collision: false, ok: true };

  // A name is a path segment under verbatim keys, so it collides with ANY
  // same-named sibling regardless of owner — root included (issue #225).
  const rows: SiblingRow[] = (s && s.sibling) || [];
  let hit = false;
  for (let i = 0; i < rows.length; i++) {
    const r: SiblingRow = rows[i] || {};
    const nm = r.displayName != null ? r.displayName : r.original_name != null ? r.original_name : r.filename;
    if (nm === pre.name) {
      hit = true;
      break;
    }
  }
  return { collision: hit, ok: !hit };
}
