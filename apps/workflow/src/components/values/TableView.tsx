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

function resolveColumns(decl: ValueDecl, rows: Record<string, unknown>[]): Column[] {
  if (Array.isArray(decl.columns)) {
    return decl.columns.map(normalizeColumn).filter((c): c is Column => c !== null)
  }
  return Object.keys(rows[0] ?? {}).map((key) => ({ key }))
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function TableView({ decl, value }: { decl: ValueDecl; value: unknown }) {
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : []
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
              <td key={c.key}>{formatCell(row[c.key])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
