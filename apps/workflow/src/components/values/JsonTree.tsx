/**
 * The `json` type's default viewer (02) and the fallback for any unrecognized
 * type: a small collapsible tree, no dependency. Objects/arrays are
 * `<details>/<summary>` nodes; primitives render inline.
 *
 * Capped: a `script` step can legitimately return an array with tens of
 * thousands of entries (hello's own `big` output is one), and one DOM node per
 * entry made the run page unusable. Each node renders at most `MAX_ENTRIES`
 * children and then says how many it left out — the summary still reports the
 * real length, so nothing about the value is hidden. Whoever needs the rest
 * downloads the payload.
 */

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

export function JsonTree({ value, name }: { value: unknown; name?: string }) {
  if (Array.isArray(value)) {
    return (
      <details className="json-node" open>
        <summary>
          {name != null && <span className="json-key">{name}: </span>}
          {`[${value.length}]`}
        </summary>
        <div className="json-children">
          {value.slice(0, MAX_ENTRIES).map((item, i) => (
            <JsonTree key={i} name={String(i)} value={item} />
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
            <JsonTree key={key} name={key} value={value[key]} />
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
