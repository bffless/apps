function handler({ steps, request, user }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  // A record's columns: flattened onto the record, or under `fields` (the client's
  // `fieldsOf` reads both the same way — as `runs/get/shape.fn.js` does).
  const nested = (r) => r && r.fields && typeof r.fields === 'object' && Object.keys(r.fields).length > 0
  const fieldsOf = (r) => (nested(r) ? r.fields : r) || {}
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

  const body = isObj(request && request.body) ? request.body : {}
  const parent = rows(steps.parent)[0] || null
  const existing = rows(steps.existing)[0] || null

  // CE hands a function_handler `user` as { id, email, role, groups }, or `undefined`
  // for a caller it could not resolve to a person (function.handler.ts). This must NEVER
  // throw: a throw is a generic FUNCTION_ERROR, not a status we get to choose — so every
  // refusal is a returned flag that one literal-status response_handler is gated on.
  const caller = user || {}
  const role = String(caller.role || '').toLowerCase()

  const refuse = (kind, error) => ({
    ok: false,
    badRequest: kind === 'badRequest',
    notFound: kind === 'notFound',
    conflict: kind === 'conflict',
    forbidden: kind === 'forbidden',
    createRun: false,
    runId: '',
    run: null,
    rows: [],
    result: { ok: false, error },
  })

  // The body's shape, before anything is read off it. `id` is rendered into the
  // 200's JSON template (`respond`), so it is held to the alphabet `newRunId`
  // mints from — a quote in it would break the response, not the row.
  const id = typeof body.id === 'string' ? body.id : ''
  const from = typeof body.from === 'string' ? body.from : ''
  const job = typeof body.job === 'string' ? body.job : ''
  const definition = isObj(body.definition) ? body.definition : null
  if (!/^run_[0-9A-Za-z]+$/.test(id)) return refuse('badRequest', 'id must be a run id')
  if (!from || !job) return refuse('badRequest', 'from and job are required')
  if (id === from) return refuse('badRequest', 'a run cannot be forked onto itself')
  if (!definition || !isObj(definition.jobs) || typeof body.yaml !== 'string') {
    return refuse('badRequest', 'definition and yaml are required')
  }

  if (!parent) return refuse('notFound', 'run not found')
  const pf = fieldsOf(parent)
  const parentJobs = isObj(pf.definition) && isObj(pf.definition.jobs) ? pf.definition.jobs : {}
  // The pick must be a job of BOTH definitions: the parent's, because the closure
  // below is computed over its `needs`; the sent one, because that is what the
  // fork runs under (#491 decision 2).
  if (!isObj(parentJobs[job]) || !isObj(definition.jobs[job])) {
    return refuse('notFound', 'job not found: ' + job)
  }
  // A live run still holds a lease and is still writing rows; cancelling is the way out.
  if (pf.status === 'running') return refuse('conflict', 'cancel the run first')
  // Owner or admin only — the delete gate's rule, verbatim. `role` is CE's *global*
  // role (users.dto.ts: admin | user | member); 'owner' is accepted for the
  // project-role vocabulary. A row written before startedBy existed is admin-only.
  const admin = role === 'admin' || role === 'owner'
  // `undefined !== undefined` is `false` — an id-less caller must never fall through
  // that comparison just because a row with no `startedBy` is *also* id-less.
  if (!admin && (!caller.id || pf.startedBy !== caller.id)) {
    return refuse('forbidden', 'only the run owner or an admin can fork a run')
  }
  // A retry must land on the row the first call made. An `id` that already names
  // some other run would have this call add step rows to it.
  if (existing) {
    const ef = fieldsOf(existing)
    if (ef.forkedFrom !== from || ef.forkJob !== job) return refuse('conflict', 'run id already in use')
  }

  // Downstream = the transitive closure of `job` over the PARENT definition's
  // `needs`, `job` included. Those jobs are what the fork re-runs; every other
  // job's rows are adopted as-is. A fixed point over the job map, no recursion:
  // the linter has already refused a cyclic `needs`, and a stray one here would
  // just mean one more pass.
  const needsOf = (name) => {
    const needs = parentJobs[name] && parentJobs[name].needs
    return Array.isArray(needs) ? needs.map(String) : typeof needs === 'string' ? [needs] : []
  }
  const downstream = {}
  downstream[job] = true
  let grew = true
  while (grew) {
    grew = false
    for (const name of Object.keys(parentJobs)) {
      if (downstream[name]) continue
      if (needsOf(name).some((need) => downstream[need] === true)) {
        downstream[name] = true
        grew = true
      }
    }
  }

  // The rule does not re-derive job outcomes (#491 decision 1): a terminal row is
  // copied whatever it says — `failed` under continue-on-error included. Whether the
  // pick is *sensible* is the client's call, as it is for Delete.
  const TERMINAL = { succeeded: true, failed: true, skipped: true, cancelled: true }
  // Every `workflow_run_steps` column the step upsert writes — the `copy` step's
  // identity `map` reads each one, so an absent value is nulled here rather than
  // left `undefined` (as `run-step/post/merge.fn.js` does for a first write).
  const COLUMNS = [
    'runId', 'key', 'job', 'index', 'step', 'kind', 'status', 'attempt', 'inputs', 'response',
    'outputs', 'error', 'summary', 'annotations', 'startedAt', 'finishedAt', 'heartbeatAt',
  ]
  const copies = []
  for (const raw of rows(steps.rows)) {
    const row = fieldsOf(raw)
    if (downstream[row.job] === true) continue
    const key = String(row.key || '')
    if (TERMINAL[row.status] !== true) return refuse('conflict', 'step ' + key + ' has not finished')
    // The fork runs under the SENT definition, so every adopted row must still be
    // addressable in it: its job, its step id, and — where the step declares an
    // `outputs` map — every output name the row recorded. A step with no `outputs`
    // map (a form, a bare pipeline step) is not output-checked: `stepOutputNames`
    // (packages/workflow-lint definition.ts) would answer a form's field names and a
    // pipeline step's `response`, and holding a stored form row to that would 409
    // every fork that adopts one.
    const sentJob = definition.jobs[row.job]
    if (!isObj(sentJob)) return refuse('conflict', 'definition changed: ' + key)
    const sentSteps = Array.isArray(sentJob.steps) ? sentJob.steps : []
    const sentStep = sentSteps.find((s) => isObj(s) && s.id === row.step) || null
    if (!sentStep) return refuse('conflict', 'definition changed: ' + key)
    if (isObj(sentStep.outputs) && isObj(row.outputs)) {
      for (const name of Object.keys(row.outputs)) {
        if (!Object.prototype.hasOwnProperty.call(sentStep.outputs, name)) {
          return refuse('conflict', 'definition changed: ' + key)
        }
      }
    }
    const copy = {}
    for (const column of COLUMNS) copy[column] = row[column] === undefined ? null : row[column]
    copy.runId = id
    copy.rowKey = id + '/' + key
    copies.push(copy)
  }

  const now = Date.now()
  return {
    ok: true,
    badRequest: false,
    notFound: false,
    conflict: false,
    forbidden: false,
    createRun: !existing,
    runId: id,
    // The new run row: the parent's identity and inputs, the body's (the alias's
    // current) file, and a fresh start — running, unattended as asked, leased to
    // the caller's tab for the same 60 s `run/lease` grants.
    run: {
      runId: id,
      impl: pf.impl,
      workflow: pf.workflow,
      workflowName: pf.workflowName,
      workflowVersion: typeof body.workflowVersion === 'string' ? body.workflowVersion : null,
      definition,
      yaml: body.yaml,
      inputs: pf.inputs === undefined ? null : pf.inputs,
      status: 'running',
      headless: false,
      unattended: body.unattended === true,
      startedBy: caller.id || null,
      startedAt: now,
      leaseOwner: String(body.owner || ''),
      leaseUntil: now + 60000,
      forkedFrom: from,
      forkJob: job,
    },
    rows: copies,
    // No `result` on this path: only the refusal responders render
    // `{{{steps.gate.result}}}`, each gated on its own flag.
  }
}
