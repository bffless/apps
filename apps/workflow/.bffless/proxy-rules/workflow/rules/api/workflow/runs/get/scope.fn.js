// `scope` — mine vs all, asked for explicitly, never assumed (spec 11
// §Listing: two queries, because a filter cannot be conditional; §The
// exemption is asked for, never assumed (D27)).
//
// A `data_query` filter is static YAML and `eq` has no wildcard, so "mine or
// everything" cannot be one query with a swapped filter value — this step
// decides which of the rule's two conditional `data_query` steps (`mine`,
// `all`) runs, and is the one 403 in the list model: an *explicit*
// `?scope=all` (or the `x-workflow-scope` header) from a caller without the
// project role for it. Everything else answers 200, `mine` by default.
//
// Never throws: a throw is CE's generic FUNCTION_ERROR, not a status we get
// to choose, so the one refusal is a returned flag and `refuse-403` is the
// only step that renders it.

// A value that may be `string | string[] | undefined` (Express repeats a
// header/query param as an array), reduced to its first entry, trimmed.
function first(value) {
  const v = Array.isArray(value) ? value[0] : value
  return typeof v === 'string' ? v.trim() : ''
}

function handler({ request, user }) {
  const req = request || {}
  const query = req.query && typeof req.query === 'object' ? req.query : {}
  const headers = req.headers && typeof req.headers === 'object' ? req.headers : {}

  // Header NAMES, case-insensitively: CE lowercases what Express hands it,
  // but a rule reached in-process by a sibling may not have — comparing the
  // key as given would silently miss the ask and narrow a list D27 says must
  // stay explicit (mirrors `src/mcp/runGate.ts`'s `header()`, which this file
  // cannot import — it is hand-authored plain JS, not TypeScript).
  let headerScope = ''
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'x-workflow-scope') {
      headerScope = first(headers[key])
      break
    }
  }

  // `?scope=all&scope=x` arrives as `string[]`; take the first rather than
  // let a repeated param fall through to `false` and silently default to
  // `mine`.
  const queryScope = first(query.scope)

  const asked = queryScope === 'all' || headerScope === 'all'
  const role = String((user || {}).projectRole || '').toLowerCase()
  const hasRole = role === 'owner' || role === 'admin'

  if (asked && !hasRole) {
    return {
      isMine: false,
      isAll: false,
      forbidden: true,
      ok: false,
      result: {
        ok: false,
        error: 'scope=all needs the project owner or admin role',
        code: 'SCOPE_FORBIDDEN',
      },
    }
  }

  if (asked) {
    return { isMine: false, isAll: true, forbidden: false, ok: true }
  }

  return { isMine: true, isAll: false, forbidden: false, ok: true }
}
