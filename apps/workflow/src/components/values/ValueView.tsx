/**
 * The one dispatch every typed value in the harness goes through — kickoff
 * inputs, `form` fields, step/job/run outputs (02): the same closed
 * vocabulary of types, always rendered read-only here (editing is a separate,
 * later concern). `list: true` repeats the base-type dispatch per item; a
 * named `render` (M2 renderers: transcript/chart/images/code/island) isn't
 * implemented yet, so it shows a placeholder badge above the base viewer
 * instead of silently falling back (Decision 10).
 */
import { FileCard } from './FileCard'
import { isFileRef } from './fileRef'
import { JsonTree } from './JsonTree'
import { MarkdownView } from './MarkdownView'
import { TableView } from './TableView'

export interface ValueDecl {
  type: string
  list?: boolean
  render?: string
  columns?: unknown
}

function ValueBody({ decl, value }: { decl: ValueDecl; value: unknown }) {
  if (value === null || value === undefined) return <span className="value-empty">—</span>

  if (decl.list) {
    if (!Array.isArray(value)) return <ValueBody decl={{ ...decl, list: false }} value={value} />
    return (
      <div className="value-list">
        {value.map((item, i) => (
          <div className="value-list-item" key={i}>
            <ValueBody decl={{ ...decl, list: false }} value={item} />
          </div>
        ))}
      </div>
    )
  }

  switch (decl.type) {
    case 'file':
      if (isFileRef(value)) return <FileCard refValue={value} />
      if (typeof value === 'string') return <span className="chip">{value}</span>
      return <JsonTree value={value} />
    case 'table':
      return <TableView decl={decl} value={value} />
    case 'markdown':
      return <MarkdownView value={String(value)} />
    case 'json':
      return <JsonTree value={value} />
    case 'string':
    case 'choice':
      return <span className="chip">{String(value)}</span>
    case 'number':
      return <span className="chip">{String(value)}</span>
    case 'boolean':
      return <span className="chip">{value ? 'true' : 'false'}</span>
    default:
      return <JsonTree value={value} />
  }
}

export function ValueView({
  decl,
  value,
  label,
  origin,
}: {
  decl: ValueDecl
  value: unknown
  label?: string
  origin?: string
}) {
  return (
    <div className="value">
      {label && <p className="value-label">{label}</p>}
      {origin && <span className="chip value-origin">from {origin}</span>}
      {decl.render && <p className="value-renderer-badge">{`renderer: ${decl.render} (M2)`}</p>}
      <ValueBody decl={decl} value={value} />
    </div>
  )
}
