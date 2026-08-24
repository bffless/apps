/**
 * The one dispatch every typed value in the harness goes through — kickoff
 * inputs, `form` fields, step/job/run outputs (02): the same closed
 * vocabulary of types, always rendered read-only here (editing is a separate,
 * later concern). `list: true` repeats the base-type dispatch per item; a
 * named `render` replaces the base viewer where one exists — `island` (Task 5)
 * today, the rest (transcript/chart/images/code) in Phase 3 — and otherwise
 * shows a placeholder badge above the base viewer rather than silently falling
 * back to it.
 *
 * `island` needs one fact no value carries: which implementation bundle its
 * `src` lives in. It comes from `ImplContext` (the page knows) or from an
 * explicit `impl` prop; with neither, the declaration degrades to the badge.
 */
import type { ValueDecl } from '../../lib/valueDecl'
import { FileCard } from './FileCard'
import { isFileRef } from './fileRef'
import { useImpl } from './implContext'
import { JsonTree } from './JsonTree'
import { MarkdownView } from './MarkdownView'
import { TableView } from './TableView'
import { IslandView } from './renderers/IslandView'

export type { ValueDecl }

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
  impl,
}: {
  decl: ValueDecl
  value: unknown
  label?: string
  origin?: string
  /** Overrides `ImplContext`; only `render: island` reads it. */
  impl?: string
}) {
  // Unconditional: `impl ?? useImpl()` would short-circuit the hook away.
  const contextImpl = useImpl()
  const bundle = impl ?? contextImpl
  const island = decl.render === 'island' && typeof decl.src === 'string' && bundle !== null

  return (
    <div className="value">
      {label && <p className="value-label">{label}</p>}
      {origin && <span className="chip value-origin">from {origin}</span>}
      {island ? (
        <IslandView decl={decl as ValueDecl & { src: string }} value={value} impl={bundle} />
      ) : (
        <>
          {decl.render && <p className="value-renderer-badge">{`renderer: ${decl.render} (M2)`}</p>}
          <ValueBody decl={decl} value={value} />
        </>
      )}
    </div>
  )
}
