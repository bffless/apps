/**
 * The `json` type's default viewer (02) and the fallback for any unrecognized
 * type: a small collapsible tree, no dependency. Objects/arrays are
 * `<details>/<summary>` nodes; primitives render inline.
 */
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
          {value.map((item, i) => (
            <JsonTree key={i} name={String(i)} value={item} />
          ))}
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
          {keys.map((key) => (
            <JsonTree key={key} name={key} value={value[key]} />
          ))}
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
