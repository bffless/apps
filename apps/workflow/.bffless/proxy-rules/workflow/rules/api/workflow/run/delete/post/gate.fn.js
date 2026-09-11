function handler({ steps }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const row = rows(steps.run)[0] || null

  const refuse = (kind, error) => ({
    ok: false,
    notFound: kind === 'notFound',
    running: kind === 'running',
    recordId: null,
    prefix: '',
    prefixLike: '',
    result: { ok: false, error },
  })

  // Defensive: this step only runs when `steps.runGate.ok` — the shared gate
  // (spec 11 D26) has already found and admitted this row, ownership included
  // — so `!row` below is a no-op in practice, not a path a caller can reach.
  if (!row) return refuse('notFound', 'run not found')
  // A live run still holds a lease and is still writing rows; cancelling is the way out.
  if (row.status === 'running') return refuse('running', 'cancel the run first')

  // The run's storage prefix (06/D18). Kickoff uploads live one level up, under
  // `inputs/`, so they are outside it — deletion must never reach them.
  const prefix = 'workflows/' + row.impl + '/' + row.workflow + '/runs/' + row.runId + '/'
  return {
    ok: true,
    notFound: false,
    running: false,
    recordId: row.id,
    prefix,
    // LIKE pattern for the workflow_files sweep, ANCHORED on purpose: the filter runs
    // over `sub_dir`, which CE stores as the key's uploads-relative directory — no
    // leading slash, no `<owner>/<repo>/uploads/` head (upload-record.service.ts;
    // live-confirmed 2026-08-30, e.g. `workflows/<impl>/<wf>/runs/<id>/<job>/<n>/<step>`).
    // Anchoring means a `%` or `_` in an implementation or workflow name can only
    // widen a match INSIDE this run's unique prefix, never reach another run's rows.
    // Every run object's `sub_dir` carries at least one segment past the prefix
    // (uploads are scoped `runs/<id>/<stepKey>` or `runs/<id>/outputs` —
    // runnerMiddleware.ts), so `prefix + '%'` misses nothing at the run root.
    prefixLike: prefix + '%',
    // No `result` on this path: only the two refusal responders render
    // `{{{steps.gate.result}}}`, and each is gated on its own refusal flag, so a
    // success-path `result` was dead weight that read as if something served it.
  }
}
