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
 * A `json` value with no renderer is first read for its *shape* (`./shape`,
 * 02 "Inferred shapes", apps#450): homogeneous rows draw as a table, numbers
 * as a compact list, File refs as file cards, a storage path as its basename
 * — and inside the tree, node by node, the same. The tree is always one
 * click away: the `json` flip on the value, or the pane's **Show raw**.
 *
 * `island` needs one fact no value carries: which implementation bundle its
 * `src` lives in. It comes from `ImplContext` (the page knows) or from an
 * explicit `impl` prop; with neither, the declaration degrades to the badge.
 */
import { useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { isUnavailablePayload } from '../../lib/runner/payload'
import type { UnavailablePayload } from '../../lib/runner/payload'
import { downloadHref, isSafeUrl } from '../../lib/url'
import type { ImageMap } from '../../lib/imageMap'
import { useFileRefs } from './fileRefIndex'
import type { ValueDecl } from '../../lib/valueDecl'
import { FileCard } from './FileCard'
import { isFileRef } from './fileRef'
import { isBlockText } from './textValue'
import { useImpl } from './implContext'
import { JsonTree } from './JsonTree'
import { MarkdownView } from './MarkdownView'
import { TableView } from './TableView'
import { InlineList, PathChip, ShapeView } from './ShapeView'
import { ShowAll } from './ShowAll'
import { useShowRaw } from './rawPreference'
import { LIST_ITEMS_PREVIEW, formatSeconds, hasShape, inferShape } from './shape'
import { IslandView } from './renderers/IslandView'
import { ImagesView } from './renderers/ImagesView'
import { TranscriptView } from './renderers/TranscriptView'
import { ChartView } from './renderers/ChartView'
import { CodeView } from './renderers/CodeView'

export type { ValueDecl }

/** Every `render` name this dispatch actually knows how to draw (island's M2 fallback aside). */
const KNOWN_RENDERERS = new Set(['island', 'transcript', 'images', 'chart', 'code'])

/** Types whose default viewer *draws* the value, so a raw view is worth offering (a bare `json` is already the tree). */
const DRAWN_TYPES = new Set(['table', 'markdown', 'file'])

/**
 * A string value, as a chip or a block by `isBlockText` (`./textValue`). `extra` adds a
 * modifier class either way (the unavailable-payload note wears one), and
 * whatever else is passed lands on the element (a `data-testid`).
 */
function TextValue({
  decl,
  text,
  extra,
  children,
  ...rest
}: {
  decl: Pick<ValueDecl, 'format'>
  text: string
  extra?: string
  children?: ReactNode
} & Omit<HTMLAttributes<HTMLElement>, 'children'>) {
  const suffix = extra ? ` ${extra}` : ''
  if (isBlockText(decl, text)) {
    return (
      <div className={`value-text${suffix}`} {...rest}>
        {text}
        {children}
      </div>
    )
  }
  return (
    <span className={`chip${suffix}`} {...rest}>
      {text}
      {children}
    </span>
  )
}

/**
 * An output the writer offloaded (`{"$file"}`, Task 12) whose bytes the read
 * path could not fetch back (`lib/payloadFetch`). The declared renderer is no
 * help here — a `markdown` viewer would stringify the sentinel, a `table`
 * viewer would show an empty table — so the chip reports what happened and
 * still offers the bytes, which may well be readable by hand (an expired
 * session, a transient 5xx). The url goes through the same allow-list a
 * `FileRef`'s does: the row's JSON is writable by any authenticated member.
 * `$error` is whatever the read path recorded — a status code, or a whole
 * response body — so the note follows the chip/block rule like any string.
 */
function UnavailablePayload({ payload }: { payload: UnavailablePayload }) {
  const { url } = payload.$file
  return (
    <TextValue
      decl={{}}
      text={`payload unavailable — ${payload.$error}`}
      extra="value-unavailable"
      data-testid="payload-unavailable"
    >
      {typeof url === 'string' && isSafeUrl(url) && (
        <a className="value-unavailable-download" href={downloadHref(url)} download>
          Download
        </a>
      )}
    </TextValue>
  )
}

/**
 * `list: true`: the base-type dispatch per item, folded past
 * `LIST_ITEMS_PREVIEW` with the count. A list of numbers is the one list that
 * reads better inline than as a row of chips (02 "Inferred shapes").
 */
function ListBody({ decl, value, images }: { decl: ValueDecl; value: unknown[]; images?: ImageMap }) {
  const [all, setAll] = useState(false)
  const item: ValueDecl = { ...decl, list: false }
  if (decl.type === 'number' && value.every((entry) => typeof entry === 'number')) {
    return <InlineList items={value} seconds={decl.format === 'seconds'} />
  }
  const folded = value.length > LIST_ITEMS_PREVIEW
  const shown = all || !folded ? value : value.slice(0, LIST_ITEMS_PREVIEW)
  return (
    <>
      <div className="value-list">
        {shown.map((entry, i) => (
          <div className="value-list-item" key={i}>
            <ValueBody decl={item} value={entry} images={images} />
          </div>
        ))}
      </div>
      {folded && <ShowAll total={value.length} unit="items" open={all} onToggle={() => setAll((on) => !on)} />}
    </>
  )
}

function ValueBody({ decl, value, images }: { decl: ValueDecl; value: unknown; images?: ImageMap }) {
  const resolve = useFileRefs()
  if (isUnavailablePayload(value)) return <UnavailablePayload payload={value} />
  if (value === null || value === undefined) return <span className="value-empty">—</span>
  // A File ref is a file wherever it turns up — a `choice` over File refs
  // records the ref (form adapter), and a bare `json` output may hold one.
  if (!decl.list && isFileRef(value)) return <FileCard refValue={value} />

  if (decl.list) {
    if (!Array.isArray(value)) return <ValueBody decl={{ ...decl, list: false }} value={value} images={images} />
    return <ListBody decl={decl} value={value} images={images} />
  }

  switch (decl.type) {
    case 'file': {
      if (isFileRef(value)) return <FileCard refValue={value} />
      // A bare path (a job/run-level `type: file` output evaluated from a path
      // string): the ref the run already holds for it, else one built from the
      // path — a file row with Download either way, never a chip.
      const resolved = typeof value === 'string' ? resolve(value) : undefined
      if (resolved) return <FileCard refValue={resolved} />
      if (typeof value === 'string') return <TextValue decl={decl} text={value} />
      return <JsonTree value={value} />
    }
    case 'table':
      return <TableView decl={decl} value={value} />
    case 'markdown':
      return <MarkdownView value={String(value)} images={images} />
    case 'json': {
      // The value's own shape first (declared `format:`, or inferred); else
      // the tree, which still draws any shaped node it meets on the way down.
      const seconds = decl.format === 'seconds'
      const shape = inferShape(value, decl)
      if (shape) return <ShapeView shape={shape} seconds={seconds} />
      return <JsonTree value={value} shapes seconds={seconds} />
    }
    case 'string': {
      // A storage path — declared `format: path`, or one by its shape — is a
      // basename with the whole path on hover; any other string follows the
      // chip/block rule below.
      const shape = typeof value === 'string' ? inferShape(value, decl) : null
      if (shape?.kind === 'path') return <PathChip path={shape.path} />
      return <TextValue decl={decl} text={String(value)} />
    }
    case 'choice':
      // A short scalar is a chip; a paragraph, a script, a prompt is a block
      // (`isBlockText`). The list branch above lands each item here in turn,
      // so a list of long strings is a column of blocks, not of ellipses.
      return <TextValue decl={decl} text={String(value)} />
    case 'number':
      if (decl.format === 'seconds' && typeof value === 'number') {
        return (
          <span className="chip" title={String(value)}>
            {formatSeconds(value)}
          </span>
        )
      }
      return <span className="chip">{String(value)}</span>
    case 'boolean':
      return <span className="chip">{value ? 'true' : 'false'}</span>
    default:
      return <JsonTree value={value} />
  }
}

/**
 * Whether the default viewer would show this value as something other than
 * the raw tree — so the `json` flip has a second side worth offering.
 */
function isDrawn(decl: ValueDecl, value: unknown): boolean {
  if (typeof decl.render === 'string' || DRAWN_TYPES.has(decl.type)) return true
  if (decl.list === true) return decl.type !== 'json' || hasShape(value)
  if (decl.type === 'json') return hasShape(value)
  if (decl.type === 'string') return inferShape(value, decl) !== null
  if (decl.type === 'number') return decl.format === 'seconds'
  return false
}

export function ValueView({
  decl,
  value,
  label,
  tag,
  origin,
  destination,
  impl,
  images,
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
   * `markdown` only: the evaluated `images` map (02, apps#446) — src as written →
   * serve url. The owning pane builds it from `decl.images` and the run state
   * (`lib/imageMap`); this dispatch only hands it to the markdown viewer.
   */
  images?: ImageMap
  /**
   * The value's declaring/consuming graph chips light up while the pointer is
   * over it (08's data-flow highlight, Task 22). Mouse only — keyboard-focus
   * parity is a follow-up, not required for M2.
   */
  onHover?: (hovering: boolean) => void
}) {
  // Unconditional: `impl ?? useImpl()` would short-circuit the hook away.
  const contextImpl = useImpl()
  // "Show me the exact data" (2026-08-26 review): any value that is drawn
  // rather than printed — a chart, a table, a transcript, markdown, a file,
  // an inferred shape — can be flipped to the raw JSON the row actually
  // holds, and back. The pane's **Show raw** (apps#450) sets the default for
  // every value at once; this value's own flip overrides it either way.
  const paneRaw = useShowRaw()
  const [ownRaw, setOwnRaw] = useState<boolean | null>(null)
  const raw = ownRaw ?? paneRaw
  const bundle = impl ?? contextImpl
  const unavailable = isUnavailablePayload(value)
  const island = decl.render === 'island' && typeof decl.src === 'string' && bundle !== null
  const transcript = decl.render === 'transcript'
  const imagesGrid = decl.render === 'images'
  const chart = decl.render === 'chart'
  const code = decl.render === 'code'

  const present = !unavailable && value !== null && value !== undefined
  const drawn = present && isDrawn(decl, value)

  let body
  if (present && raw && (drawn || ownRaw === null)) {
    body = <JsonTree value={value} />
  } else if (island && !unavailable) {
    body = <IslandView decl={decl as ValueDecl & { src: string }} value={value} impl={bundle} />
  } else if (transcript && !unavailable) {
    body = <TranscriptView value={value} />
  } else if (imagesGrid && !unavailable) {
    body = <ImagesView value={value} />
  } else if (chart && !unavailable) {
    body = <ChartView value={value} mapping={decl.mapping} />
  } else if (code && !unavailable) {
    body = <CodeView value={value} mapping={decl.mapping} />
  } else {
    // The badge says why the declared renderer did not draw this value.
    //
    // A *known* renderer only lands here when it could not dispatch, and the
    // one that can is `island`: it needs both a `src` and an implementation to
    // resolve it against, so the badge names whichever is missing. It used to
    // say "(M2)" — the milestone the island viewer was then owed — which read
    // as a status of the harness rather than of this declaration, and has been
    // wrong since the named renderers landed (apps#382).
    //
    // Any other named `render` reaching this branch got here because its
    // payload is unavailable: the badge would only repeat what the
    // `payload-unavailable` chip already says, so a known renderer gets none.
    // A genuinely unrecognised `render` value keeps its "(unknown)".
    const isKnownRenderer = typeof decl.render === 'string' && KNOWN_RENDERERS.has(decl.render)
    const showBadge = Boolean(decl.render) && !(unavailable && isKnownRenderer)
    const why = !isKnownRenderer
      ? 'unknown'
      : typeof decl.src !== 'string'
        ? 'no src'
        : 'no implementation'
    body = (
      <>
        {showBadge && (
          <p className="value-renderer-badge">{`renderer: ${decl.render} (${why})`}</p>
        )}
        <ValueBody decl={decl} value={value} images={images} />
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
          {drawn && (
            <button
              type="button"
              className="value-raw"
              data-testid="value-raw"
              aria-pressed={raw}
              title={raw ? 'Show it as declared' : 'Show the raw JSON'}
              onClick={() => setOwnRaw(!raw)}
            >
              {raw ? 'rendered' : 'json'}
            </button>
          )}
        </div>
      )}
      {body}
    </div>
  )
}
