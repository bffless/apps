/**
 * Readers for what CE's `data_query` steps answer — the same envelope
 * tolerance every harness `*.fn.js` carries (a bare array, or one wrapped as
 * `records` / `data` / `rows`; a record's columns flattened or under
 * `fields`) — plus `runs/get/shape.fn.js`'s `waitingOn` join, typed.
 */

export type Row = Record<string, unknown>

function isPlainObject(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The records of a `data_query` answer, whichever envelope this CE used. */
export function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result.filter(isPlainObject)
  if (!isPlainObject(result)) return []
  const inner = result.records ?? result.data ?? result.rows
  return Array.isArray(inner) ? inner.filter(isPlainObject) : []
}

/** A record's columns: flattened onto the record, or under `fields` (the client's `fieldsOf` reads both the same way). */
export function fieldsOf(row: Row): Row {
  const fields = row.fields
  return isPlainObject(fields) && Object.keys(fields).length > 0 ? fields : row
}

/**
 * `data_update` answered a record (any envelope) — the write landed. Read by
 * `reply` (a verdict is only honest if its write did) and by `plan` (only a
 * landed write re-dispatches the run's driver, ADR-0006), so it lives with the
 * other readers of what a data step answers rather than in either caller.
 */
export function stepUpdated(update: unknown): boolean {
  if (update === undefined || update === null) return false
  if (isPlainObject(update) && update.success === false) return false
  return true
}

/** The record's own id (needed by `data_update`), wherever this CE keeps it. */
export function recordIdOf(row: Row): string | null {
  const id = row.id ?? fieldsOf(row).id
  return typeof id === 'string' ? id : null
}

/**
 * `runs/get/shape.fn.js` (apps#473): each listed run's columns plus
 * `waitingOn` — the sorted keys of its `waiting` step rows.
 */
export function runsWithWaiting(runRows: unknown, waitingRows: unknown): Array<Row & { waitingOn: string[] }> {
  const waiting = new Map<string, string[]>()
  for (const row of rows(waitingRows)) {
    const f = fieldsOf(row)
    if (typeof f.runId !== 'string' || typeof f.key !== 'string') continue
    const keys = waiting.get(f.runId) ?? []
    keys.push(f.key)
    waiting.set(f.runId, keys)
  }
  return rows(runRows).map((row) => {
    const f = fieldsOf(row)
    const keys = [...(waiting.get(typeof f.runId === 'string' ? f.runId : '') ?? [])].sort()
    return { ...f, waitingOn: keys }
  })
}
