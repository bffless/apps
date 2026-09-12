/**
 * When does this run expire? (spec 05 §Retention, apps#686.)
 *
 * `expiresAt = startedAt + keep`, epoch ms, when the definition being snapshotted
 * carries a top-level `keep:` — `<n>h` or `<n>d`, the schema's own `$defs.keep`
 * grammar and not the `duration` one, so `30m` is not a keep. No `expiresAt` key
 * at all otherwise — CE's evaluator answers `undefined` for a property the step
 * output lacks (expression-evaluator.ts getNestedValue) and the JSONB write drops
 * it, so the row carries no column, the way a kickoff run carries no `forkedFrom`.
 * An explicit `null` would be STORED as null. A workflow without `keep:` is never
 * swept. The nightly sweep that reads the column is apps#615.
 *
 * Computed here and never read from the body — like `startedBy` (`admit.fn.js`),
 * the caller does not get to choose it. `admit` decides ownership and nothing
 * else, which is why this is its own step; `run/fork` computes the same value
 * inside its `gate.fn.js`, because that rule's `create` reads every column from
 * the gate's one assembled row (`src/mocks/expiry.fn.parity.test.ts` holds the
 * two together).
 *
 * Never throws: a throw is CE's generic FUNCTION_ERROR, not a status this rule
 * gets to choose, so every input is read defensively.
 */
function handler(data) {
  const ctx = data || {}
  const request = ctx.request || {}
  const body = request.body !== null && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
  const definition = body.definition !== null && typeof body.definition === 'object' && !Array.isArray(body.definition) ? body.definition : {}

  const match = typeof definition.keep === 'string' ? /^([0-9]+)(h|d)$/.exec(definition.keep) : null
  const startedAt = typeof body.startedAt === 'number' && Number.isFinite(body.startedAt) ? body.startedAt : null
  if (!match || startedAt === null) return {}

  const unit = match[2] === 'd' ? 86400000 : 3600000
  return { expiresAt: startedAt + Number(match[1]) * unit }
}
