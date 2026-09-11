/**
 * Who does this new run belong to? (spec 11 §Attribution, D28.)
 *
 * A run dispatched from the MCP endpoint is inserted by the DRIVER's identity —
 * `workflow-headless` logs into the harness as itself and its browser posts
 * here — so `startedBy: user.id` would hand every driven run to the driver.
 * `run/drive` therefore wrote a `workflow_run_claims` row for the requester and
 * gave the driver a nonce; this step redeems it. The rule's `create` step reads
 * `startedBy`/`startedByEmail`/`driveKey` from here and from nowhere else, and
 * a `startedBy` or `driveKey` in the BODY is never read at all.
 *
 * Four outcomes, in order:
 *
 * 1. the run id is taken → `exists` (409), whatever else is true — the 07
 *    `runId=` backstop for the race between the page's pre-insert read and
 *    this insert;
 * 2. a claim, and the request carries its nonce → `fresh` + `claimed`: the
 *    run is the CLAIMANT's, and the rule's `consume` step deletes the claim;
 * 3. a claim, and the nonce is missing or wrong → `exists` (409). A caller who
 *    cannot prove it was dispatched cannot take a claimed id either;
 * 4. no claim → today's behaviour, the browser-started path: the session's own
 *    member.
 *
 * Never throws: a throw is CE's generic FUNCTION_ERROR, not a status this rule
 * gets to choose, so every input is read defensively.
 */
function handler(data) {
  const ctx = data || {}
  const steps = ctx.steps || {}
  const user = ctx.user || {}
  // data_query answers a bare array (or an envelope on older CE versions), and a
  // record's columns are flattened or under `fields` — the same tolerance every
  // other hand-written function in this set carries.
  const rows = (r) => (Array.isArray(r) ? r : (r && (r.records || r.data || r.rows)) || [])
  const fieldsOf = (row) => (row && row.fields && Object.keys(row.fields).length > 0 ? row.fields : row || {})
  const str = (v) => (typeof v === 'string' ? v : '')

  // A header's first value, case-insensitively: CE lowercases what Express hands
  // it, but a rule reached in-process by a sibling may not have.
  const headers = (ctx.request && ctx.request.headers) || {}
  let sent = ''
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'x-workflow-drive-key') continue
    const value = headers[name]
    sent = str(Array.isArray(value) ? value[0] : value).trim()
    break
  }

  const taken = rows(steps.find).length > 0
  const claimRow = rows(steps.claim)[0] || null
  const claim = claimRow ? fieldsOf(claimRow) : null
  const held = claim ? str(claim.driveKey) : ''
  const redeemed = claim !== null && held !== '' && sent === held

  if (taken || (claim !== null && !redeemed)) {
    return {
      exists: true,
      fresh: false,
      claimed: false,
      claimRecordId: null,
      startedBy: null,
      startedByEmail: '',
      driveKey: '',
    }
  }

  if (redeemed) {
    return {
      exists: false,
      fresh: true,
      claimed: true,
      // Wherever this CE keeps the record id — on the record, or among the
      // columns — as the string `consume`'s data_delete interpolates.
      claimRecordId: String((claimRow && claimRow.id) || claim.id || '') || null,
      startedBy: str(claim.startedBy) || null,
      startedByEmail: str(claim.startedByEmail),
      // The nonce moves onto the run row, which is what opens the shared gate's
      // `drive` door for every later request the driven page makes (D26).
      driveKey: held,
    }
  }

  return {
    exists: false,
    fresh: true,
    claimed: false,
    claimRecordId: null,
    startedBy: str(user.id) || null,
    startedByEmail: str(user.email),
    driveKey: '',
  }
}
