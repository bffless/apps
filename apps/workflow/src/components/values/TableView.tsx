/**
 * The `table` type's default viewer (02): `value` is an array of row
 * objects; headers come from `decl.columns` when given, else from the keys
 * of the first row.
 */
import type { ValueDecl } from './ValueView'

interface Column {
  key: string
  label?: string
  type?: string
}

function normalizeColumn(entry: unknown): Column | null {
  if (typeof entry === 'string') return { key: entry }
  if (entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string') {
    return entry as Column
  }
  return null
}

/** A row is only a row if it is an object — anything else has no cells. */
function asRow(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function resolveColumns(decl: ValueDecl, rows: unknown[]): Column[] {
  if (Array.isArray(decl.columns)) {
    return decl.columns.map(normalizeColumn).filter((c): c is Column => c !== null)
  }
  return Object.keys(asRow(rows[0]) ?? {}).map((key) => ({ key }))
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function TableView({ decl, value }: { decl: ValueDecl; value: unknown }) {
  // A `table` value is whatever a step actually emitted, so a null or scalar
  // row is a value to render (as empty cells), not an exception to throw.
  const rows: unknown[] = Array.isArray(value) ? value : []
  const columns = resolveColumns(decl, rows)
  return (
    <table className="value-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key}>{c.label ?? c.key}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c.key}>{formatCell(asRow(row)?.[c.key])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
