/**
 * The `json` type's default viewer (02) and the fallback for any unrecognized
 * type: a small collapsible tree, no dependency. Objects/arrays are
 * `<details>/<summary>` nodes; primitives render inline.
 *
 * With `shapes`, a node whose value has a shape (`./shape`, 02 "Inferred
 * shapes") is drawn by that shape's viewer in place — a list of File refs
 * inside a job's outputs is four file cards under their key, a hundred
 * floats a compact list, a storage path a basename chip — so the tree is
 * the map and the shapes are the territory. Without it (the Raw flip) every
 * node is a node and every leaf a leaf.
 *
 * Capped: a `script` step can legitimately return an array with tens of
 * thousands of entries (hello's own `big` output is one), and one DOM node per
 * entry made the run page unusable. Each node renders at most `MAX_ENTRIES`
 * children and then says how many it left out — the summary still reports the
 * real length, so nothing about the value is hidden. Whoever needs the rest
 * downloads the payload.
 */
import { ShapeView } from './ShapeView'
import { inferShape } from './shape'

export const MAX_ENTRIES = 200

function More({ count }: { count: number }) {
  return (
    <div className="json-more" data-testid="json-more">
      … {count} more {count === 1 ? 'entry' : 'entries'}
    </div>
  )
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function primitiveLabel(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

export function JsonTree({
  value,
  name,
  shapes = false,
  seconds = false,
}: {
  value: unknown
  name?: string
  /** Draw shaped nodes with their shape's viewer instead of as subtrees. */
  shapes?: boolean
  /** With `shapes`: every number in a shaped node is a time in seconds (`format: seconds`). */
  seconds?: boolean
}) {
  if (shapes) {
    const shape = inferShape(value)
    if (shape) {
      return (
        <div className="json-node json-shaped" data-testid="json-shaped" data-shape={shape.kind}>
          {name != null && <span className="json-key">{name}: </span>}
          <ShapeView shape={shape} seconds={seconds} />
        </div>
      )
    }
  }

  if (Array.isArray(value)) {
    return (
      <details className="json-node" open>
        <summary>
          {name != null && <span className="json-key">{name}: </span>}
          {`[${value.length}]`}
        </summary>
        <div className="json-children">
          {value.slice(0, MAX_ENTRIES).map((item, i) => (
            <JsonTree key={i} name={String(i)} value={item} shapes={shapes} seconds={seconds} />
          ))}
          {value.length > MAX_ENTRIES && <More count={value.length - MAX_ENTRIES} />}
        </div>
      </details>
    )
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    return (
      <details className="json-node" open>
        <summary>
          {name != null && <span className="json-key">{name}: </span>}
          {`{${keys.length}}`}
        </summary>
        <div className="json-children">
          {keys.slice(0, MAX_ENTRIES).map((key) => (
            <JsonTree key={key} name={key} value={value[key]} shapes={shapes} seconds={seconds} />
          ))}
          {keys.length > MAX_ENTRIES && <More count={keys.length - MAX_ENTRIES} />}
        </div>
      </details>
    )
  }

  return (
    <div className="json-leaf">
      {name != null && <span className="json-key">{name}: </span>}
      <span className="json-value">{primitiveLabel(value)}</span>
    </div>
  )
}
