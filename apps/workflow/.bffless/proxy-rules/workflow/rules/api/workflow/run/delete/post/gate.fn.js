function handler({ steps, request, user }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const row = rows(steps.run)[0] || null

  // CE hands a function_handler `user` as { id, email, role, groups }, or `undefined`
  // for a caller it could not resolve to a person (function.handler.ts). This must NEVER
  // throw: a throw is a generic FUNCTION_ERROR, not a status we get to choose — so every
  // refusal is a returned flag that one literal-status response_handler is gated on.
  const caller = user || {}
  const role = String(caller.role || '').toLowerCase()

  const refuse = (kind, error) => ({
    ok: false,
    notFound: kind === 'notFound',
    running: kind === 'running',
    forbidden: kind === 'forbidden',
    recordId: null,
    prefix: '',
    prefixLike: '',
    result: { ok: false, error },
  })

  if (!row) return refuse('notFound', 'run not found')
  // A live run still holds a lease and is still writing rows; cancelling is the way out.
  if (row.status === 'running') return refuse('running', 'cancel the run first')
  // Owner or admin only (spec 05, Retention & deletion). `role` is CE's *global* role
  // (users.dto.ts: admin | user | member); 'owner' is accepted for the project-role
  // vocabulary. A row written before startedBy existed is admin-only, by construction.
  const admin = role === 'admin' || role === 'owner'
  // `undefined !== undefined` is `false` — an id-less caller (one
  // `function_handler` could not resolve to a person) must never fall through
  // that comparison just because a row written before `startedBy` existed is
  // *also* missing one. `!caller.id` closes that: no id, no ownership match.
  if (!admin && (!caller.id || row.startedBy !== caller.id)) {
    return refuse('forbidden', 'only the run owner or an admin can delete a run')
  }

  // The run's storage prefix (06/D18). Kickoff uploads live one level up, under
  // `inputs/`, so they are outside it — deletion must never reach them.
  const prefix = 'workflows/' + row.impl + '/' + row.workflow + '/runs/' + row.runId + '/'
  return {
    ok: true,
    notFound: false,
    running: false,
    forbidden: false,
    recordId: row.id,
    prefix,
    // ILIKE pattern for the workflow_files sweep. Leading `%` on purpose: CE stores an
    // upload record's `storage_path` as the FULL object key
    // (`<owner>/<repo>/uploads/` + the prefix above — upload-record.service.ts), not the
    // uploads-relative path that `file_delete` takes. The run id inside the pattern is
    // unique, so the leading wildcard cannot reach another run's rows.
    prefixLike: '%' + prefix + '%',
    // No `result` on this path: only the three refusal responders render
    // `{{{steps.gate.result}}}`, and each is gated on its own refusal flag, so a
    // success-path `result` was dead weight that read as if something served it.
  }
}
