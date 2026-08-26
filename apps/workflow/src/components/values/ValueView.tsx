/**
 * The one dispatch every typed value in the harness goes through — kickoff
 * inputs, `form` fields, step/job/run outputs (02): the same closed
 * vocabulary of types, always rendered read-only here (editing is a separate,
 * later concern). `list: true` repeats the base-type dispatch per item; a
 * named `render` replaces the base viewer where one exists — `island` (Task 5),
 * `transcript`/`images` (Task 15) so far, `chart`/`code` still to come (Task
 * 16, falls to the base viewer with no badge in the meantime) — and otherwise
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

export type { ValueDecl }

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
  const unavailable = isUnavailablePayload(value)
  const island = decl.render === 'island' && typeof decl.src === 'string' && bundle !== null
  const transcript = decl.render === 'transcript'
  const images = decl.render === 'images'

  let body
  if (island && !unavailable) {
    body = <IslandView decl={decl as ValueDecl & { src: string }} value={value} impl={bundle} />
  } else if (transcript && !unavailable) {
    body = <TranscriptView value={value} />
  } else if (images && !unavailable) {
    body = <ImagesView value={value} />
  } else {
    // `chart`/`code` (Task 16) fall through to the base viewer with no badge —
    // their renderers don't exist yet, so a placeholder would be more
    // misleading than silence. `island` keeps its historical "(M2)" badge
    // when it can't dispatch (no src, or no implementation known); any other
    // named `render` this dispatch doesn't recognise gets the "(unknown)"
    // badge instead.
    const isChartOrCode = decl.render === 'chart' || decl.render === 'code'
    const isIslandFallback = decl.render === 'island'
    body = (
      <>
        {decl.render && !isChartOrCode && (
          <p className="value-renderer-badge">
            {`renderer: ${decl.render} (${isIslandFallback ? 'M2' : 'unknown'})`}
          </p>
        )}
        <ValueBody decl={decl} value={value} />
      </>
    )
  }

  return (
    <div className="value">
      {label && <p className="value-label">{label}</p>}
      {origin && <span className="chip value-origin">from {origin}</span>}
      {body}
    </div>
  )
}
