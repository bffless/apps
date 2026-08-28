/**
 * `workflow-headless runs` — the last N runs of one workflow, as a table.
 *
 * The row shape is CE's Data Table shape, which may arrive flattened or under
 * `fields`, and the list itself may be a bare array or wrapped in
 * `records`/`data`/`rows` — the same tolerance the harness's own `coerce.ts`
 * applies, for the same reason: the rule has answered more than one of these.
 */
import type { ApiLike } from './api.js'

export interface RunRow {
  runId: string
  status: string
  startedAt: number
  workflowName: string
  headless: boolean
}

function rowsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  const r = (raw ?? {}) as Record<string, unknown>
  for (const key of ['records', 'data', 'rows']) {
    if (Array.isArray(r[key])) return r[key] as unknown[]
  }
  return []
}

function fieldsOf(raw: unknown): Record<string, unknown> {
  const r = (raw ?? {}) as Record<string, unknown>
  const nested = (r.fields ?? {}) as Record<string, unknown>
  return Object.keys(nested).length > 0 ? nested : r
}

export function toRunRows(raw: unknown): RunRow[] {
  return rowsOf(raw)
    .map((entry) => {
      const f = fieldsOf(entry)
      return {
        runId: typeof f.runId === 'string' ? f.runId : '',
        status: typeof f.status === 'string' ? f.status : '',
        startedAt: typeof f.startedAt === 'number' ? f.startedAt : Number(f.startedAt ?? 0) || 0,
        workflowName: typeof f.workflowName === 'string' ? f.workflowName : '',
        headless: f.headless === true || f.headless === 'true',
      }
    })
    .sort((a, b) => b.startedAt - a.startedAt)
}

const when = (at: number) => (at > 0 ? new Date(at).toISOString() : '')

export function formatRunsTable(rows: RunRow[]): string {
  if (rows.length === 0) return 'no runs'
  const header = ['STARTED', 'STATUS', 'HEADLESS', 'RUN ID']
  const body = rows.map((r) => [when(r.startedAt), r.status, r.headless ? 'yes' : '', r.runId])
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => (cells[i] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd()
  return [line(header), ...body.map(line)].join('\n')
}

export async function listRuns(
  api: ApiLike,
  impl: string,
  workflow: string,
  last: number,
): Promise<RunRow[]> {
  const query = `impl=${encodeURIComponent(impl)}&workflow=${encodeURIComponent(workflow)}`
  const res = await api.json(`/api/workflow/runs?${query}`)
  if (res.status !== 200) throw new Error(`/api/workflow/runs answered ${res.status}`)
  return toRunRows(res.body).slice(0, last)
}
