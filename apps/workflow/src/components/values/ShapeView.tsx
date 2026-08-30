/**
 * The viewers behind a value's *shape* (`./shape`, 02 "Inferred shapes",
 * apps#450): file cards for File refs the JSON happened to be wearing, a table
 * for homogeneous rows, a compact inline list for scalars, a basename chip
 * for a storage path. `ValueView` uses them for a whole value; `JsonTree`
 * uses them for a node inside one, so the tree drills into shaped data rather
 * than spelling it out. Every one of them sits behind the Raw flip.
 */
import { useEffect, useState } from 'react'
import { FileCard } from './FileCard'
import { ShowAll } from './ShowAll'
import { TableView } from './TableView'
import { LIST_ITEMS_PREVIEW, LIST_PREVIEW, basename, formatNumber, formatSeconds } from './shape'
import type { FileRef } from '../../lib/runner/types'
import type { Scalar, Shape } from './shape'

/** A scalar as a list item reads it: numbers to a sensible precision (or as seconds), null as a dash. */
function formatScalar(value: Scalar, seconds: boolean): string {
  if (value === null) return '—'
  if (typeof value === 'number') return seconds ? formatSeconds(value) : formatNumber(value)
  return String(value)
}

/**
 * `1.68, 5.03, 8.39 … (120)` — the first `LIST_PREVIEW` items inline, the
 * count, and the rest behind "show all". `seconds` formats every number as
 * `m:ss.s` (a `format: seconds` declaration). A list of nothing but strings
 * is a row of chips instead of a comma-joined line: a string can hold a
 * comma of its own (`Hello, world!`), and then the joins are ambiguous.
 */
export function InlineList({ items, seconds = false }: { items: Scalar[]; seconds?: boolean }) {
  const [all, setAll] = useState(false)
  const folded = items.length > LIST_PREVIEW
  const shown = all || !folded ? items : items.slice(0, LIST_PREVIEW)
  const chips = items.every((item) => typeof item === 'string')
  return (
    <div className="value-inline-list" data-testid="inline-list">
      {chips ? (
        shown.map((item, i) => (
          <span className="chip" key={i}>
            {String(item)}
          </span>
        ))
      ) : (
        <span className="value-inline-items">
          {shown.map((item) => formatScalar(item, seconds)).join(', ')}
          {folded && !all ? ' …' : ''}
        </span>
      )}
      <span className="value-count">({items.length})</span>
      {folded && <ShowAll total={items.length} unit="items" open={all} onToggle={() => setAll((on) => !on)} />}
    </div>
  )
}

/** A list of file cards, folded past `LIST_ITEMS_PREVIEW` like any other list. */
export function FilesView({ refs }: { refs: FileRef[] }) {
  const [all, setAll] = useState(false)
  const folded = refs.length > LIST_ITEMS_PREVIEW
  const shown = all || !folded ? refs : refs.slice(0, LIST_ITEMS_PREVIEW)
  return (
    <>
      <div className="value-list">
        {shown.map((ref, i) => (
          <div className="value-list-item" key={`${ref.path}:${i}`}>
            <FileCard refValue={ref} />
          </div>
        ))}
      </div>
      {folded && <ShowAll total={refs.length} unit="files" open={all} onToggle={() => setAll((on) => !on)} />}
    </>
  )
}

/**
 * A storage path as its basename, the whole path on hover, and a Copy for the
 * person who needs it verbatim. The clipboard is a best effort: no permission,
 * no secure context, no clipboard at all — the chip still shows the path.
 */
export function PathChip({ path }: { path: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(path).then(
        () => setCopied(true),
        () => undefined,
      )
    } catch {
      // No clipboard here — the path is still on the chip and in its title.
    }
  }
  return (
    <span className="chip value-path" title={path} data-testid="value-path">
      <span className="value-path-name">{basename(path)}</span>
      <button type="button" className="value-copy" aria-label={`Copy ${path}`} onClick={copy}>
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  )
}

export function ShapeView({ shape, seconds = false }: { shape: Shape; seconds?: boolean }) {
  switch (shape.kind) {
    case 'file':
      return <FileCard refValue={shape.ref} />
    case 'files':
      return <FilesView refs={shape.refs} />
    case 'table':
      return <TableView decl={{ type: 'table', columns: shape.columns }} value={shape.rows} shaped seconds={seconds} />
    case 'list':
      return <InlineList items={shape.items} seconds={seconds} />
    case 'path':
      return <PathChip path={shape.path} />
  }
}
