// Join each listed run's *waiting* steps onto its run record (apps#473).
//
// Past runs reads run rows only — no per-run step fetch — but the one
// step-level fact it shows ("waiting on <step>") lives on the step rows. So
// the rule runs a query for every `status = waiting` step row and this
// attaches, to each run in the page, the keys of the ones that are its own:
// `waitingOn: ["<job>/<index>/<step>", …]`, always present, `[]` when the run
// waits on nothing. Step rows carry no impl/workflow to narrow that query on,
// and it is capped by its limit; the client resolves each key's display name
// from the run row's own `definition` snapshot.
//
// The run page itself comes from whichever of the rule's two conditional
// `data_query` steps ran (spec 11 §Listing): `mine` (the caller's own runs)
// or `all` (asked for, and only ever populated once `scope.fn.js` allowed
// it) — exactly one of the two is ever anything but `undefined`. The same is
// true of `queuedMine`/`queuedAll`, the claim queries whose unconsumed rows
// this appends to the page as `queued` entries (apps#671).

// How long a claim lists as `queued` before the list writes it off (apps#681).
// Kept in sync with `src/mcp/driveGate.ts`'s `CLAIM_STALE_MS` (which is
// `src/mcp/ids.ts`'s `PENDING_WINDOW_MS`, 10 minutes) — restated because an
// authored `.fn.js` cannot import, and pinned to that export behaviourally by
// `src/mocks/runs.shape.fn.parity.test.ts`. The harness gives ONE answer to
// how long a dispatch may take: past this window `workflow.status` stops
// answering `pending` for a run with no row (its `pendingUntil`), and the
// drive gate lets the next caller take the id over from another member. A
// claim older than this is a dispatch the harness has written off, so the
// list stops promising the run is coming when the status already has.
//
// Two edges this accepts, on purpose: (1) the gate reuses a caller's OWN
// standing claim whatever its age, `createdAt` and all, so a retry after the
// window is unlisted here until the driver's first write lands — the same
// ~90 s `workflow.status` already answers "no run" for, since it measures
// from the id's mint. Re-stamping the claim would extend the foreign-takeover
// hold instead. (2) The gate reads a non-number `createdAt` as claimed NOW;
// this reads it through `Number()` (below). The schema types the column as a
// number, so neither reading is ever exercised on a stored row.
const CLAIM_STALE_MS = 600000

function handler({ steps }) {
  // data_query answers a bare array (or one record with returnSingle) — CE's
  // data-query.handler.ts `output = returnSingle ? results[0] : results`; the envelope
  // forms are kept for older CE versions.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  // A record's columns: flattened onto the record, or under `fields` (the client's
  // `fieldsOf` reads both the same way).
  const nested = (r) => r && r.fields && typeof r.fields === 'object' && Object.keys(r.fields).length > 0
  const fieldsOf = (r) => (nested(r) ? r.fields : r) || {}
  // `driveKey` (spec 11 D28) is the dispatched driver's nonce: legitimate on
  // the stored row, never on a response body — it travels only in
  // `client_payload.drive_key` and the `x-workflow-drive-key` request header.
  // Strip it from whichever shape this CE answered before it rides the page.
  const withoutDriveKey = (row) => {
    if (!row) return row
    if (nested(row)) {
      if (!('driveKey' in row.fields)) return row
      const fields = Object.assign({}, row.fields)
      delete fields.driveKey
      return Object.assign({}, row, { fields })
    }
    if (!('driveKey' in row)) return row
    const copy = Object.assign({}, row)
    delete copy.driveKey
    return copy
  }

  const waiting = {}
  for (const row of rows(steps.waiting)) {
    const f = fieldsOf(row)
    if (typeof f.runId !== 'string' || typeof f.key !== 'string') continue
    if (!waiting[f.runId]) waiting[f.runId] = []
    waiting[f.runId].push(f.key)
  }

  const page = rows(steps.mine !== undefined ? steps.mine : steps.all).map((row) => {
    const keys = (waiting[fieldsOf(row).runId] || []).slice().sort()
    // Put the column where the record keeps its other columns, so the client
    // reads it with the rest of the row.
    const shaped = nested(row)
      ? Object.assign({}, row, { fields: Object.assign({}, row.fields, { waitingOn: keys }) })
      : Object.assign({}, row, { waitingOn: keys })
    return withoutDriveKey(shaped)
  })

  // The dispatched runs nobody has picked up yet (apps#671). A claim is written
  // before the dispatch and deleted the instant the driver's first write lands,
  // so every claim still standing is a run that was asked for and has no
  // `workflow_runs` row — the window the list was blind to. One synthetic
  // `queued` entry each, from whichever of the two scoped claim queries ran.
  //
  // Built from an explicit allow-list, never by spreading the claim row: that
  // row carries `driveKey` (spec 11 D28), the dispatched driver's nonce, and it
  // must not ride a response body under any shape.
  const seen = Object.create(null)
  for (const row of page) {
    const runId = fieldsOf(row).runId
    if (typeof runId === 'string') seen[runId] = true
  }

  const claims = rows(steps.queuedMine !== undefined ? steps.queuedMine : steps.queuedAll)
  for (const row of claims) {
    const f = fieldsOf(row)
    // A claim whose run row is already in the page is spent-but-still-listed
    // (the queries are separate snapshots), and a claim is deliberately
    // re-usable after a failed dispatch — either way the page must carry one
    // entry per runId, not two.
    if (typeof f.runId !== 'string' || f.runId === '' || seen[f.runId]) continue
    // The harness has written this dispatch off (apps#681): the list stops
    // promising it is coming. Read through `Number()` for the comparison only
    // — a claim's `createdAt` can arrive as a numeric string (see `startedAt`
    // below) and a `typeof` test would leave this inert on it. A value that
    // does not read as a finite time keeps the entry: wrongly hiding a real
    // queued run is worse than listing a stale one.
    const age = Date.now() - Number(f.createdAt)
    if (Number.isFinite(age) && age > CLAIM_STALE_MS) continue
    seen[f.runId] = true
    const queued = {
      runId: f.runId,
      impl: typeof f.impl === 'string' ? f.impl : '',
      workflow: typeof f.workflow === 'string' ? f.workflow : '',
      status: 'queued',
      // When the dispatch was asked for — the only time a queued entry has.
      // Passed through as stored, NOT normalised to a number here: the run
      // rows travel untouched and are coerced client-side (`coerce.ts`'s
      // `num`, which reads a numeric string too), and a queued entry that
      // collapsed a string to `0` here would render 1970 and sort to the
      // bottom — the opposite of the point.
      startedAt: f.createdAt,
      // Nothing waits on a run that has not started; `[]` keeps the column
      // present on every row in the page, as the run rows have it.
      waitingOn: [],
    }
    if (typeof f.startedBy === 'string') queued.startedBy = f.startedBy
    if (typeof f.startedByEmail === 'string') queued.startedByEmail = f.startedByEmail
    // Appended, not merged in order: sorting is the client's (Decision 6), and
    // it sorts on `startedAt`, which these carry.
    page.push(queued)
  }

  return page
}
