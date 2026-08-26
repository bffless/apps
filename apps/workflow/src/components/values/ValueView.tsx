/**
 * The one dispatch every typed value in the harness goes through — kickoff
 * inputs, `form` fields, step/job/run outputs (02): the same closed
 * vocabulary of types, always rendered read-only here (editing is a separate,
 * later concern). `list: true` repeats the base-type dispatch per item; a
 * named `render` replaces the base viewer where one exists — `island` (Task 5),
 * `transcript`/`images` (Task 15), `chart`/`code` (Task 16) — and otherwise
 * shows a placeholder badge above the base viewer rather than silently falling
 * back to it.
 *
 * `island` needs one fact no value carries: which implementation bundle its
 * `src` lives in. It comes from `ImplContext` (the page knows) or from an
 * explicit `impl` prop; with neither, the declaration degrades to the badge.
 */
import { isUnavailablePayload } from '../../lib/runner/payload'
import type { UnavailablePayload } from '../../lib/runner/payload'
import { downloadHref, isSafeUrl } from '../../lib/url'
import type { ValueDecl } from '../../lib/valueDecl'
import { FileCard } from './FileCard'
import { isFileRef } from './fileRef'
import { useImpl } from './implContext'
import { JsonTree } from './JsonTree'
import { MarkdownView } from './MarkdownView'
import { TableView } from './TableView'
import { IslandView } from './renderers/IslandView'
import { ImagesView } from './renderers/ImagesView'
import { TranscriptView } from './renderers/TranscriptView'
import { ChartView } from './renderers/ChartView'
import { CodeView } from './renderers/CodeView'

export type { ValueDecl }

/** Every `render` name this dispatch actually knows how to draw (island's M2 fallback aside). */
const KNOWN_RENDERERS = new Set(['island', 'transcript', 'images', 'chart', 'code'])

/**
 * An output the writer offloaded (`{"$file"}`, Task 12) whose bytes the read
 * path could not fetch back (`lib/payloadFetch`). The declared renderer is no
 * help here — a `markdown` viewer would stringify the sentinel, a `table`
 * viewer would show an empty table — so the chip reports what happened and
 * still offers the bytes, which may well be readable by hand (an expired
 * session, a transient 5xx). The url goes through the same allow-list a
 * `FileRef`'s does: the row's JSON is writable by any authenticated member.
 */
function UnavailablePayload({ payload }: { payload: UnavailablePayload }) {
  const { url } = payload.$file
  return (
    <span className="chip value-unavailable" data-testid="payload-unavailable">
      {`payload unavailable — ${payload.$error}`}
      {typeof url === 'string' && isSafeUrl(url) && (
        <a className="value-unavailable-download" href={downloadHref(url)} download>
          Download
        </a>
      )}
    </span>
  )
}

function ValueBody({ decl, value }: { decl: ValueDecl; value: unknown }) {
  if (isUnavailablePayload(value)) return <UnavailablePayload payload={value} />
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
  tag,
  origin,
  destination,
  impl,
  onHover,
}: {
  decl: ValueDecl
  value: unknown
  label?: string
  /** A mono tag beside the label — the declared type and renderer (08's "file list", "table"). */
  tag?: string
  /** Where the value came from: renders as the "from …" provenance chip (08). */
  origin?: string
  /** Where the value goes next: renders as the "goes to …" chip (08). */
  destination?: string
  /** Overrides `ImplContext`; only `render: island` reads it. */
  impl?: string
  /**
   * The value's declaring/consuming graph chips light up while the pointer is
   * over it (08's data-flow highlight, Task 22). Mouse only — keyboard-focus
   * parity is a follow-up, not required for M2.
   */
  onHover?: (hovering: boolean) => void
}) {
  // Unconditional: `impl ?? useImpl()` would short-circuit the hook away.
  const contextImpl = useImpl()
  const bundle = impl ?? contextImpl
  const unavailable = isUnavailablePayload(value)
  const island = decl.render === 'island' && typeof decl.src === 'string' && bundle !== null
  const transcript = decl.render === 'transcript'
  const images = decl.render === 'images'
  const chart = decl.render === 'chart'
  const code = decl.render === 'code'

  let body
  if (island && !unavailable) {
    body = <IslandView decl={decl as ValueDecl & { src: string }} value={value} impl={bundle} />
  } else if (transcript && !unavailable) {
    body = <TranscriptView value={value} />
  } else if (images && !unavailable) {
    body = <ImagesView value={value} />
  } else if (chart && !unavailable) {
    body = <ChartView value={value} mapping={decl.mapping} />
  } else if (code && !unavailable) {
    body = <CodeView value={value} mapping={decl.mapping} />
  } else {
    // `island` keeps its historical "(M2)" badge when it can't dispatch (no
    // src, or no implementation known). Any other named `render` reaching
    // this branch got here because its payload is unavailable — the badge
    // would only repeat what the `payload-unavailable` chip already says, and
    // for a *known* renderer it would say it wrongly ("(unknown)" on a
    // renderer this dispatch knows perfectly well) — so a known renderer gets
    // no badge at all here, and only a genuinely unrecognised `render` value
    // keeps the "(unknown)" badge.
    const isKnownRenderer = typeof decl.render === 'string' && KNOWN_RENDERERS.has(decl.render)
    const showBadge = Boolean(decl.render) && !(unavailable && isKnownRenderer)
    body = (
      <>
        {showBadge && (
          <p className="value-renderer-badge">
            {`renderer: ${decl.render} (${isKnownRenderer ? 'M2' : 'unknown'})`}
          </p>
        )}
        <ValueBody decl={decl} value={value} />
      </>
    )
  }

  return (
    <div
      className="value"
      onMouseEnter={onHover && (() => onHover(true))}
      onMouseLeave={onHover && (() => onHover(false))}
    >
      {(label || origin || destination || tag) && (
        <div className="value-head">
          {label && <p className="value-label">{label}</p>}
          {origin && <span className="chip value-origin">from {origin}</span>}
          {destination && <span className="chip value-origin">goes to {destination}</span>}
          {tag && <span className="value-tag">{tag}</span>}
        </div>
      )}
      {body}
    </div>
  )
}
