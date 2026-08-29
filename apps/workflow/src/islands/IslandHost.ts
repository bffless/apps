/**
 * The island host (04, Decisions 9–11): the harness as an **MCP Apps host**.
 *
 * One island step = one `AppBridge` over one `<iframe sandbox="allow-scripts">`
 * whose HTML the harness fetched and injected as `srcdoc`. The frame therefore
 * has an opaque origin — no cookies, no storage, no same-origin fetch — so every
 * capability the island has is one it asks the host for: `tools/call` (its own
 * implementation's pipelines, plus the three `workflow.*` host tools),
 * `resources/read` for sibling bundle assets, `ui/open-link`, `ui/message`,
 * `ui/request-display-mode`.
 *
 * This module owns the *effects*: the fetch, the frame, the bridge, the 30 s
 * `ISLAND_LOAD` timer. Every decision that can be made from plain data — where
 * a `src` or a tool name resolves to, whether a submit is valid — lives in the
 * pure adapter (`lib/runner/adapters/island.ts`) and is imported from here. The
 * fence runs one way: `lib/runner/**` must never import this file.
 *
 * SDK notes worth knowing before editing (verified against ext-apps 1.7.5):
 * - `new AppBridge(null, …)` is the supported "no MCP client" shape: nothing is
 *   proxied to a server, and the host answers every request itself.
 * - The View's `ui/initialize` carries only `appInfo`/`appCapabilities`; there is
 *   no `_meta.ui.permissions` on it (permissions are *resource* metadata, and the
 *   harness fetches raw HTML, not a `ui://` resource). `IslandFrame`'s
 *   `permissions` prop is wired through `buildAllowAttribute` for the day that
 *   changes; nothing supplies it today.
 * - The View's zod schema for `ui/notifications/tool-input` strips unknown keys,
 *   so a headless flag cannot ride `_meta` there. `hostContext` is `.passthrough()`
 *   on both `McpUiHostContextSchema` and the `ui/initialize` result, so
 *   `hostContext.bffless.headless` is the channel instead (Decision 7): the host
 *   sets it below and it is delivered on `ui/initialize`, readable from the View
 *   as `app.getHostContext().bffless`.
 * - The View-side method is `app.callServerTool(...)`, not `app.callTool(...)`
 *   as spec 04's example still writes it.
 */
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiResourceTeardownRequest,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { resolveSrc, resolveToolName } from '../lib/runner/adapters/island'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import { isSafeUrl } from '../lib/url'

/** The View has 30 s from `srcdoc` to `ui/notifications/initialized` (global constraints). */
export const ISLAND_INIT_TIMEOUT_MS = 30_000

/** A View that ignores `ui/resource-teardown` must not hold the run open. */
const TEARDOWN_TIMEOUT_MS = 2_000

/** Inline islands never grow past this share of the viewport (04's size-changed). */
const INLINE_HEIGHT_CAP = 0.8

/**
 * Who the harness says it is on `ui/initialize`. The version is the *host
 * protocol* version this module implements, not the app's release — islands
 * feature-detect against it, so bump it when the host surface changes.
 */
const HOST_INFO = { name: 'bffless-workflow', version: '1.0.0' } as const

/**
 * `ui/request-display-mode` has no capability flag of its own; the host
 * advertises what it can do through `hostContext.availableDisplayModes`. `pip`
 * is not one of them (04).
 */
const DISPLAY_MODES = ['inline', 'fullscreen'] as const

export type IslandDisplayMode = (typeof DISPLAY_MODES)[number]

/**
 * The island genuinely could not be shown: the HTML was not 2xx, the View never
 * completed `ui/initialize` within 30 s, or the bridge would not connect.
 * Carries the `code` the step's `error` will be recorded under (Decision 11).
 *
 * Deliberately **not** a superclass of `IslandMountAbandoned`: a caller that
 * writes `err instanceof IslandLoadError` is asking "is this the step's
 * failure?", and the answer for an abandoned mount is no. Keeping the two types
 * disjoint makes that distinction impossible to lose by accident.
 */
export class IslandLoadError extends Error {
  readonly code = 'ISLAND_LOAD' as const

  constructor(message: string) {
    super(message)
    this.name = 'IslandLoadError'
  }
}

/**
 * The mount was **abandoned**, not failed: the step went away while its island
 * was still loading (cancelled, the pane unmounted, a second `mount` superseded
 * this one — React StrictMode's dev double-mount does exactly that on every
 * island's first load). Nothing is wrong with the island, so nothing about it
 * belongs in the run record: the caller re-mounts, or lets the step's own
 * terminal event stand.
 */
export class IslandMountAbandoned extends Error {
  readonly code = 'ISLAND_ABANDONED' as const

  constructor(message: string) {
    super(message)
    this.name = 'IslandMountAbandoned'
  }
}

export interface IslandHostDeps {
  /** `tools/call` → the implementation's own proxy rules. */
  http: HttpJson
  /** The island HTML, and `resources/read` for its siblings. */
  fetchText: (url: string) => Promise<{ ok: boolean; status: number; text: string }>
  /** `workflow.submit` — the middleware's `completeIslandStep`. */
  onSubmit: (outputs: unknown) => { ok: true } | { ok: false; errors: Record<string, string> }
  /** `workflow.annotate` — the middleware's `annotateEvent` (Decision 12). */
  onAnnotate: (args: unknown) => { ok: true } | { ok: false; error: string }
  /**
   * `workflow.sign` — `hostDeps`'s `signFile`, bound to the caller's `http`
   * (Decision 6). Rejects with the message the island should see.
   */
  sign: (path: string, signal?: AbortSignal) => Promise<{ url: string; expiresIn: number }>
  /** The island asked to go fullscreen (or back); the page owns the layout. */
  onDisplayMode: (mode: IslandDisplayMode) => void
  /** `ui/message` / `notifications/message` — a live line on the step card. */
  onLog: (line: string) => void
  /** `ui/open-link`, already `isSafeUrl`-gated by the host. */
  openLink: (url: string) => void
  now: () => number
  /**
   * Test seam. The default builds the real
   * `PostMessageTransport(contentWindow, contentWindow)`: ext-apps posts with
   * `targetOrigin "*"` and filters on `event.source`, and the `WindowProxy`
   * survives the `srcdoc` navigation, so an opaque origin works. Unit tests
   * inject an `InMemoryTransport` half instead (jsdom will not accept a fake
   * `Window` as `MessageEvent.source`).
   */
  transport?: (iframe: HTMLIFrameElement) => Transport
}

export interface IslandMountArgs {
  impl: string
  src: string
  /** The tool-input `arguments` — in viewer mode the caller passes `{ value }` (04). */
  arguments: Record<string, unknown>
  /** `render: island`: the same file, read-only — `workflow.submit` is refused. */
  viewer?: boolean
  headless: boolean
  signal: AbortSignal
}

export interface IslandHost {
  /**
   * Fetches the HTML, mounts the bridge on `iframe`, resolves after
   * `ui/notifications/initialized`. Rejects `IslandLoadError` when the island
   * itself could not be shown (non-2xx fetch, 30 s with no `ui/initialize`, a
   * bridge that would not connect) and `IslandMountAbandoned` when the mount
   * was given up on instead (abort, teardown, a superseding mount) — the two
   * are different facts, and only the first is the step's failure.
   */
  mount(iframe: HTMLIFrameElement, a: IslandMountArgs): Promise<void>
  /**
   * The *page* changed the display mode (the user left fullscreen, a run moved
   * on). The island only ever **asks** through `ui/request-display-mode`; the
   * store is the source of truth, so the answer has to flow back down or the
   * bridge keeps telling the island it is fullscreen — which also leaves the
   * size-changed handler disabled. No-op with no session, or when unchanged.
   */
  setDisplayMode(mode: IslandDisplayMode): void
  /**
   * A **viewer's** value changed: send a fresh `ui/notifications/tool-input`
   * over the live bridge instead of remounting the island (apps#370). A step's
   * island is sent tool-input exactly once, by `mount` — re-sending would
   * restart it under the user's hands — so this rejects for a non-viewer
   * session. No-op with no connected session (the pending `mount` carries the
   * arguments the frame reads at that point), and likewise while the mount is
   * still delivering its own tool-input — sending then would put the new value
   * ahead of the mount's.
   */
  sendToolInput(args: Record<string, unknown>): Promise<void>
  /** `ui/resource-teardown` then disconnect; idempotent, and safe before a mount. */
  teardown(reason: 'cancelled' | 'completed' | 'unmounted'): Promise<void>
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toolError(text: string, meta?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }], ...(meta ? { _meta: meta } : {}) }
}

/**
 * A non-2xx pipeline answer, in the island's vocabulary: the same
 * `code`/`message` extraction the pipeline step adapter applies (03), flattened
 * into one line because MCP has no error object — plus the raw status under
 * `_meta.bffless` for an island that wants to branch on it (Decision 10).
 */
function httpToolError(url: string, status: number, body: unknown): CallToolResult {
  const b = obj(body)
  const code = str(b.code) ?? str(b.error) ?? `HTTP_${status}`
  const message =
    str(b.message) ??
    str(b.error) ??
    str(typeof body === 'string' ? body : undefined) ??
    `${url} failed with status ${status}`
  return toolError(`${code}: ${message}`, { bffless: { status } })
}

/**
 * MCP's `structuredContent` is an object, so a pipeline that answers with a
 * bare array/number (or with text) is wrapped rather than dropped: a string
 * body becomes `{ text }`, anything else non-object `{ value }`.
 */
function structured(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>
  }
  return typeof body === 'string' ? { text: body } : { value: body }
}

/** Enough of a map to label the assets an island actually reads through the bridge. */
const MIME: Record<string, string> = {
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  html: 'text/html',
  svg: 'image/svg+xml',
  md: 'text/markdown',
  txt: 'text/plain',
}

function mimeOf(path: string): string | undefined {
  const ext = path.split('.').pop()
  return ext ? MIME[ext.toLowerCase()] : undefined
}

const DARK_SCHEME = '(prefers-color-scheme: dark)'

/** The host's theme follows the OS, like the harness page itself. jsdom has no `matchMedia`. */
function currentTheme(): 'light' | 'dark' {
  const query = globalThis.matchMedia?.(DARK_SCHEME)
  return query?.matches ? 'dark' : 'light'
}

function containerDimensions(iframe: HTMLIFrameElement): McpUiHostContext['containerDimensions'] {
  const rect = iframe.getBoundingClientRect()
  return {
    width: Math.round(rect.width),
    maxHeight: Math.round(globalThis.innerHeight * INLINE_HEIGHT_CAP),
  }
}

/**
 * Keep a connected island's `theme` and `containerDimensions` current
 * (apps#370): both were sampled once at `mount`, so an OS theme flip or a
 * viewport resize never reached the View. Returns the disposer. Either
 * observer may be missing (jsdom has neither), in which case that half is
 * simply never re-sent.
 */
function observeHostContext(current: Session): () => void {
  const disposers: (() => void)[] = []

  const query = globalThis.matchMedia?.(DARK_SCHEME)
  if (query?.addEventListener) {
    const onChange = (e: { matches: boolean }) => {
      notifyHostContext(current, { theme: e.matches ? 'dark' : 'light' })
    }
    query.addEventListener('change', onChange)
    disposers.push(() => query.removeEventListener('change', onChange))
  }

  if (typeof globalThis.ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      notifyHostContext(current, { containerDimensions: containerDimensions(current.iframe) })
    })
    observer.observe(current.iframe)
    disposers.push(() => observer.disconnect())
  }

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

/**
 * Apply a host-context diff and, when there is a live transport, tell the
 * View through `ui/notifications/host-context-changed`.
 *
 * The diff is written into the **same `hostContext` object the `AppBridge`
 * was constructed with**, never a copy: before the bridge connects that object
 * is what the `ui/initialize` answer carries (so a pre-connect change rides the
 * handshake instead of a notification the bridge cannot send yet — fix round 4,
 * finding 2), and after it the bridge's own copy stays in step for free.
 *
 * The notification is sent directly rather than through
 * `bridge.setHostContext`: that helper discards the promise
 * `Protocol.notification()` returns, so a transport that died between the
 * `connected` check and the send would surface as an unhandled rejection —
 * the sync `try/catch` that used to wrap it could never fire (apps#370).
 */
function notifyHostContext(current: Session, diff: Partial<McpUiHostContext>): void {
  if (current.disposed) return
  Object.assign(current.hostContext, diff)
  if (!current.connected) return
  void Promise.resolve(current.bridge.sendHostContextChange(diff)).catch(() => {
    // The frame is going away regardless; `onclose` clears `connected`.
  })
}

const CAPABILITIES: McpUiHostCapabilities = {
  // `tools/call` — the implementation's pipelines plus `workflow.submit`/`.annotate`.
  serverTools: {},
  // `resources/read` — `ui://bffless/<impl>/…` siblings of the island file.
  serverResources: {},
  openLinks: {},
  logging: {},
  message: { text: {} },
  // Accepted and ignored in v1 (04).
  updateModelContext: { text: {}, structuredContent: {} },
}

/**
 * Move a live session to `mode`, telling the View through `host-context-changed`.
 * Returns false when nothing changed, so the two callers — the island's own
 * request and the page's `setDisplayMode` — can both be idempotent and cannot
 * ping-pong (the page's answer to a request arrives here as "unchanged").
 *
 * A session is registered synchronously by `mount`, so the page can — and for
 * a `display: fullscreen` island always does — reach this function while the
 * HTML fetch is still in flight; `notifyHostContext` handles both halves of
 * that (the pre-connect mode rides `ui/initialize`, a connected one is a
 * notification).
 *
 * Entering fullscreen clears the inline height: it is an *inline style*, so a
 * stale `height: 320px` from the last size-changed beats
 * `.island-fullscreen .island-frame { height: 100% }`. Entering inline leaves
 * the height empty for the next size-changed to set (`min-height` covers a
 * silent island).
 */
function applyDisplayMode(current: Session, mode: IslandDisplayMode): boolean {
  if (current.disposed || current.displayMode === mode) return false
  current.displayMode = mode
  notifyHostContext(current, { displayMode: mode })
  if (mode === 'fullscreen') current.iframe.style.height = ''
  return true
}

/**
 * The one error every "the step went away mid-load" path rejects with — an
 * abandonment, never a load failure, so a caller cannot mistake a StrictMode
 * double-mount or a pane the user navigated away from for a broken island.
 */
function cancelledWhileLoading(url: string): IslandMountAbandoned {
  return new IslandMountAbandoned(`island ${url}: the step went away while loading`)
}

/** One mounted island: its bridge, and the frame/flags its handlers close over. */
interface Session {
  bridge: AppBridge
  iframe: HTMLIFrameElement
  hostContext: McpUiHostContext
  displayMode: IslandDisplayMode
  /** `render: island` — tool-input may be re-sent; `workflow.submit` is refused. */
  viewer: boolean
  /**
   * `bridge.connect` has resolved and the transport has not closed since —
   * i.e. there is a transport to notify over. Cleared by the bridge's
   * `onclose`, so a frame yanked without `teardown()` stops being notified
   * instead of re-floating `Not connected` on every later call (apps#370).
   */
  connected: boolean
  /**
   * The mount has delivered its own `tool-input`. A viewer re-send before this
   * point would land *ahead* of the mount's and leave the island on the stale
   * value, so `sendToolInput` is a no-op until then (the frame re-checks once
   * the mount resolves).
   */
  ready: boolean
  disposed: boolean
  /** Stops the theme / resize observers. */
  unobserve: () => void
}

// ---------------------------------------------------------------------------

export function createIslandHost(deps: IslandHostDeps): IslandHost {
  /** At most one island is ever live: a second `mount` supersedes the first. */
  let session: Session | null = null

  const makeTransport =
    deps.transport ??
    ((iframe: HTMLIFrameElement) => {
      const view = iframe.contentWindow
      if (!view) throw new IslandLoadError('the island frame has no content window')
      return new PostMessageTransport(view, view)
    })

  /** Close a bridge without asking the View first — used when superseding. */
  async function discard(current: Session): Promise<void> {
    if (current.disposed) return
    current.disposed = true
    current.unobserve()
    if (session === current) session = null
    try {
      await current.bridge.close()
    } catch {
      // A transport that is already gone is exactly what we wanted.
    }
  }

  function install(current: Session, a: IslandMountArgs): void {
    const { bridge } = current

    // The transport closed — our own `close()`, or a transport closed out of
    // band — so there is nothing left to notify over. (A frame simply removed
    // from the DOM closes no transport; that case is benign only because
    // `notifyHostContext` catches the rejection.)
    bridge.onclose = () => {
      current.connected = false
    }

    bridge.oncalltool = async (params, extra): Promise<CallToolResult> => {
      const target = resolveToolName(a.impl, params.name, params._meta)
      const args = obj(params.arguments)

      if (target.kind === 'rejected') return toolError(target.reason)

      if (target.kind === 'host') {
        if (target.tool === 'submit') {
          if (a.viewer) {
            return toolError('workflow.submit is not available in a read-only viewer')
          }
          const submitted = deps.onSubmit(args.outputs)
          if (submitted.ok) return { content: [{ type: 'text', text: 'ok' }] }
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(submitted.errors) }],
            structuredContent: { errors: submitted.errors },
          }
        }

        // Unlike `submit`/`annotate` a viewer may sign: signing changes
        // nothing about the run, and a `render: island` viewer showing media
        // has no other way to load it (Decision 6).
        if (target.tool === 'sign') {
          try {
            const signed = await deps.sign(typeof args.path === 'string' ? args.path : '', extra.signal)
            return {
              content: [{ type: 'text', text: signed.url }],
              structuredContent: { url: signed.url, expiresIn: signed.expiresIn },
            }
          } catch (err) {
            return toolError(messageOf(err))
          }
        }

        const annotated = deps.onAnnotate(args)
        if (annotated.ok) return { content: [{ type: 'text', text: 'ok' }] }
        return {
          isError: true,
          content: [{ type: 'text', text: annotated.error }],
          structuredContent: { error: annotated.error },
        }
      }

      // A pipeline. The island says the verb (Decision 10) — the host cannot
      // know a rule's method — and the request rides the member's session, so
      // an island never sees a credential.
      try {
        const res = await deps.http(
          target.url,
          target.method === 'GET'
            ? { method: 'GET', query: args, signal: extra.signal }
            : { method: 'POST', body: args, signal: extra.signal },
        )
        if (!res.ok) return httpToolError(target.url, res.status, res.body)
        return {
          content: [{ type: 'text', text: JSON.stringify(res.body) }],
          structuredContent: structured(res.body),
        }
      } catch (err) {
        return toolError(`${target.url}: ${messageOf(err)}`)
      }
    }

    // `ui://bffless/<impl>/<rest>` → `/w/<impl>/<rest>`: the escape hatch for an
    // opaque-origin frame that cannot fetch its own siblings. `resolveSrc` is
    // the same own-implementation fence the island's `src` passed through, so
    // another implementation's bundle is unreachable from here too.
    bridge.onreadresource = async ({ uri }) => {
      const prefix = `ui://bffless/${a.impl}/`
      if (!uri.startsWith(prefix)) {
        throw new Error(`resource ${uri}: only ${prefix}… is readable from this island`)
      }
      const url = resolveSrc(a.impl, uri.slice(prefix.length))
      const res = await deps.fetchText(url)
      if (!res.ok) throw new Error(`resource ${uri}: ${url} failed with status ${res.status}`)
      const mimeType = mimeOf(url)
      return { contents: [{ uri, ...(mimeType ? { mimeType } : {}), text: res.text }] }
    }

    bridge.onopenlink = async ({ url }) => {
      // Navigation the member's own click drives, not a byte sink the harness
      // reads on their behalf — `isSafeUrl`'s plain allow-list is the right
      // question here, not the stricter same-origin media-sink gate (apps#363).
      if (!isSafeUrl(url)) return { isError: true }
      deps.openLink(url)
      return {}
    }

    bridge.onmessage = async ({ content }) => {
      const text = textOf(content)
      if (text) deps.onLog(text)
      return {}
    }

    // `inline` ↔ `fullscreen` only (04). Anything else — `pip` — is answered
    // with the mode already in force, which is what the spec asks a host to do.
    bridge.onrequestdisplaymode = async ({ mode }) => {
      if ((mode === 'inline' || mode === 'fullscreen') && applyDisplayMode(current, mode)) {
        deps.onDisplayMode(mode)
      }
      return { mode: current.displayMode }
    }

    bridge.onupdatemodelcontext = async () => ({})

    bridge.addEventListener('loggingmessage', ({ data }) => {
      deps.onLog(typeof data === 'string' ? data : JSON.stringify(data))
    })

    // The frame is only ours to resize while it is inline; in fullscreen the
    // page owns the box.
    bridge.addEventListener('sizechange', ({ height }) => {
      if (current.disposed || current.displayMode !== 'inline') return
      if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
      const cap = Math.round(globalThis.innerHeight * INLINE_HEIGHT_CAP)
      current.iframe.style.height = `${Math.min(Math.round(height), cap)}px`
    })
  }

  /** Resolves on `ui/notifications/initialized`; rejects on abort or the 30 s cap. */
  function waitForInitialized(current: Session, url: string, signal: AbortSignal): Promise<void> {
    const startedAt = deps.now()

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        settled = true
        current.bridge.removeEventListener('initialized', onInitialized)
        signal.removeEventListener('abort', onAbort)
        clearTimeout(timer)
      }

      const onInitialized = () => {
        if (settled) return
        cleanup()
        resolve()
      }

      const onAbort = () => {
        if (settled) return
        cleanup()
        reject(cancelledWhileLoading(url))
      }

      const timer = setTimeout(() => {
        if (settled) return
        cleanup()
        const waited = Math.max(deps.now() - startedAt, ISLAND_INIT_TIMEOUT_MS)
        reject(new IslandLoadError(`island ${url}: no ui/initialize within ${waited} ms`))
      }, ISLAND_INIT_TIMEOUT_MS)

      current.bridge.addEventListener('initialized', onInitialized)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    })
  }

  return {
    async mount(iframe, a) {
      // `resolveSrc` throws on a `src` that escapes the bundle — a definition
      // bug, not a runtime state (09), so it is not dressed up as ISLAND_LOAD.
      const url = resolveSrc(a.impl, a.src)

      // Cheapest checkpoint of all: a step cancelled before its pane rendered
      // never opens a socket or a request.
      if (a.signal.aborted) throw cancelledWhileLoading(url)

      const hostContext = {
        theme: currentTheme(),
        displayMode: 'inline',
        availableDisplayModes: [...DISPLAY_MODES],
        platform: 'web',
        containerDimensions: containerDimensions(iframe),
        // Plan Decision 7: the View's tool-input schema strips `_meta`, but hostContext is passthrough.
        bffless: { headless: a.headless },
      } as McpUiHostContext & { bffless: { headless: boolean } }

      // The bridge keeps this exact object and answers `ui/initialize` with it,
      // so a pre-connect `applyDisplayMode` mutation reaches the View through
      // the handshake rather than through a notification it cannot send yet.
      const current: Session = {
        bridge: new AppBridge(null, HOST_INFO, CAPABILITIES, { hostContext }),
        iframe,
        hostContext,
        displayMode: 'inline',
        viewer: a.viewer === true,
        connected: false,
        ready: false,
        disposed: false,
        unobserve: () => {},
      }
      install(current, a)
      // From here on a theme flip or resize lands in `hostContext` — before the
      // bridge connects that is the object `ui/initialize` will answer with, so
      // nothing sampled during the HTML fetch goes stale.
      current.unobserve = observeHostContext(current)

      // Registered *before* the first await, so `teardown()` and a second
      // `mount()` can both find and dispose an in-flight mount. Everything
      // after an await therefore re-checks `settled()`: the session may have
      // been superseded or torn down while we were suspended, and connecting a
      // bridge or writing `srcdoc` after that leaks a live island.
      const previous = session
      session = current

      const settled = () => current.disposed || session !== current || a.signal.aborted
      const abandon = async (): Promise<never> => {
        await discard(current)
        throw cancelledWhileLoading(url)
      }

      // A second mount supersedes the first: two live bridges on one step would
      // both answer `tools/call`. (React StrictMode's dev double-mount already
      // tears the first down through `IslandFrame`; this is the backstop.)
      if (previous) await discard(previous)
      if (settled()) return abandon()

      let html: { ok: boolean; status: number; text: string }
      try {
        html = await deps.fetchText(url)
      } catch (err) {
        await discard(current)
        throw new IslandLoadError(`island ${url}: ${messageOf(err)}`)
      }
      if (settled()) return abandon()
      if (!html.ok) {
        await discard(current)
        throw new IslandLoadError(`island ${url}: failed with status ${html.status}`)
      }

      // Order matters, and this is the raceless one: connect *first* so the
      // bridge is already listening, then hand the frame its HTML. Setting
      // `srcdoc` only schedules the navigation, so the reverse order also
      // happens to work — but only because `connect()` registers its listener
      // synchronously. Don't rely on that.
      try {
        await current.bridge.connect(makeTransport(iframe))
        current.connected = true
      } catch (err) {
        await discard(current)
        throw new IslandLoadError(`island ${url}: ${messageOf(err)}`)
      }
      // The last checkpoint before the frame is allowed to run any script.
      if (settled()) return abandon()

      iframe.srcdoc = html.text

      try {
        await waitForInitialized(current, url, a.signal)
      } catch (err) {
        await discard(current)
        throw err
      }

      // The step's `with` (minus `src`/`title`/`display`), verbatim — and in
      // viewer mode the caller's `{ value }`. The headless flag does not ride
      // here (see the top-of-file note); it went out on `ui/initialize` above.
      try {
        await sendToolInput(current, a.arguments)
      } catch (err) {
        await discard(current)
        throw new IslandLoadError(`island ${url}: ${messageOf(err)}`)
      }
      current.ready = true
    },

    setDisplayMode(mode) {
      if (session) applyDisplayMode(session, mode)
    },

    async sendToolInput(args) {
      const current = session
      if (!current || current.disposed) return
      if (!current.viewer) {
        throw new Error("tool-input is only re-sent to a viewer; a step's island is mounted once")
      }
      if (!current.ready || !current.connected) return
      await sendToolInput(current, args)
    },

    async teardown(reason) {
      const current = session
      if (!current || current.disposed) return
      current.disposed = true
      current.unobserve()
      session = null

      // `ui/resource-teardown` is a *request*: an island that never set
      // `app.onteardown` answers method-not-found, and one that hangs must not
      // hold the run open — so it is bounded and swallowed either way.
      try {
        await current.bridge.teardownResource(
          { reason } as McpUiResourceTeardownRequest['params'],
          { timeout: TEARDOWN_TIMEOUT_MS },
        )
      } catch {
        // Nothing to do: we are unmounting the frame regardless.
      }

      try {
        await current.bridge.close()
      } catch {
        // Already gone.
      }
    },
  }
}

/**
 * `ui/notifications/tool-input`: the step's `with` (minus `src`/`title`/
 * `display`) verbatim, or a viewer's `{ value }`. No `_meta` — the headless
 * flag rides `hostContext.bffless.headless` instead (see the top-of-file note).
 */
function sendToolInput(current: Session, args: Record<string, unknown>): Promise<void> {
  return current.bridge.sendToolInput({ arguments: args })
}

/** The text blocks of an MCP content list, joined — the only modality the step card shows. */
function textOf(content: ContentBlock[] | undefined): string {
  return (content ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}
