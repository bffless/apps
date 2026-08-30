/**
 * The `table` type's default viewer (02), and the viewer behind an inferred
 * or `format: table` json value (02 "Inferred shapes"): `value` is an array
 * of row objects; headers come from `decl.columns` when given, else from the
 * keys of the first row.
 *
 * A *shaped* table (inferred, or `format: table`) reads the way a person
 * reads it: a number to a sensible precision, and as `m:ss.s` when its column
 * says it is a time in seconds (`isTimeKey`, or `seconds` for the whole table)
 * — the exact number on hover, the Raw flip one click away. A declared
 * `type: table` prints its cells as they are, as it always has; numbers are
 * right-aligned either way. Past `TABLE_PREVIEW_ROWS` the rest fold behind
 * "show all".
 */
import { useState } from 'react'
import type { ValueDecl } from './ValueView'
import { ShowAll } from './ShowAll'
import { TABLE_PREVIEW_ROWS, formatNumber, formatSeconds, isTimeKey } from './shape'

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

interface Cell {
  text: string
  numeric: boolean
  /** The exact value, when the text rounded or reformatted it. */
  title?: string
}

function formatCell(value: unknown, key: string, shaped: boolean, seconds: boolean): Cell {
  if (value === null || value === undefined) return { text: '—', numeric: false }
  if (typeof value === 'number') {
    if (!shaped) return { text: String(value), numeric: true }
    const time = (seconds || isTimeKey(key)) && Number.isFinite(value) && value >= 0
    const text = time ? formatSeconds(value) : formatNumber(value)
    return { text, numeric: true, title: text === String(value) ? undefined : String(value) }
  }
  if (typeof value === 'object') return { text: JSON.stringify(value), numeric: false }
  return { text: String(value), numeric: false }
}

export function TableView({
  decl,
  value,
  shaped = false,
  seconds = false,
}: {
  decl: ValueDecl
  value: unknown
  /** An inferred or `format: table` table: numbers to a sensible precision, time-like columns as `m:ss.s`. */
  shaped?: boolean
  /** Every numeric cell is a time in seconds (`format: seconds` on the declaration). */
  seconds?: boolean
}) {
  // A `table` value is whatever a step actually emitted, so a null or scalar
  // row is a value to render (as empty cells), not an exception to throw.
  const rows: unknown[] = Array.isArray(value) ? value : []
  const columns = resolveColumns(decl, rows)
  const [all, setAll] = useState(false)
  const folded = rows.length > TABLE_PREVIEW_ROWS
  const shown = all || !folded ? rows : rows.slice(0, TABLE_PREVIEW_ROWS)
  const numeric = new Set(
    columns.filter((c) => rows.some((row) => typeof asRow(row)?.[c.key] === 'number')).map((c) => c.key),
  )
  return (
    <table className="value-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} data-num={numeric.has(c.key) ? '' : undefined}>
              {c.label ?? c.key}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shown.map((row, i) => (
          <tr key={i}>
            {columns.map((c) => {
              const cell = formatCell(asRow(row)?.[c.key], c.key, shaped, seconds)
              return (
                <td key={c.key} data-num={cell.numeric ? '' : undefined} title={cell.title}>
                  {cell.text}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
      {folded && (
        <tfoot>
          <tr>
            <td colSpan={columns.length}>
              <ShowAll total={rows.length} unit="rows" open={all} onToggle={() => setAll((on) => !on)} />
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}
