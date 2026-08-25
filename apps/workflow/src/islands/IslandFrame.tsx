/**
 * The island's frame: one `<iframe sandbox="allow-scripts">` (opaque origin —
 * no cookies, no storage, no same-origin fetch, Decision 9) and the mount /
 * teardown lifecycle around it.
 *
 * The component owns nothing but the element and the effect; every protocol
 * decision belongs to `IslandHost`. Mount is fire-and-forget from React's point
 * of view, so the effect carries an `AbortController`: a cleanup that runs
 * before the mount settles (React StrictMode's dev double-mount, or a step that
 * finishes while its HTML is still in flight) aborts the attempt and tears the
 * bridge down, and the stale promise's rejection is dropped rather than
 * reported as a load error.
 */
import { useEffect, useRef } from 'react'
import { buildAllowAttribute } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { McpUiResourcePermissions } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { IslandDisplayMode, IslandHost } from './IslandHost'

export interface IslandFrameProps {
  impl: string
  src: string
  arguments: Record<string, unknown>
  /** `render: island`: read-only, `workflow.submit` refused. */
  viewer?: boolean
  headless: boolean
  display: IslandDisplayMode
  title?: string
  /**
   * `_meta.ui.permissions` → the iframe `allow` attribute. Nothing supplies it
   * yet: the harness fetches raw HTML, not a `ui://` resource, so there is no
   * resource metadata to read it from — the prop is the seam for the day an
   * island is served as a real MCP resource (04 "Later").
   */
  permissions?: McpUiResourcePermissions
  /**
   * Must be **referentially stable** for the life of the step: it is an effect
   * dependency, so a host rebuilt on every render would re-mount the island on
   * every render.
   */
  host: IslandHost
  onLoadError: (err: { code: 'ISLAND_LOAD'; message: string }) => void
}

/**
 * What the island has been (or would be) told, as a string. Tool input travels
 * as JSON, so two structurally equal values are one value — and a live run
 * page rebuilds its state on every poll, so identity would remount a viewer
 * every few seconds. `undefined` and a value JSON cannot describe both collapse
 * to a constant: an unserialisable value could not be delivered anyway.
 */
function toolInputSignature(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args) ?? 'undefined'
  } catch {
    return 'unserialisable'
  }
}

export function IslandFrame(props: IslandFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const { host, impl, src, viewer, headless, onLoadError } = props

  // The island is mounted for the identity of the step, not for every render:
  // `arguments` is a fresh object each time the pane re-renders, and re-sending
  // tool input would restart a step's island under the user's hands. The one
  // `tool-input` a step gets is sent by `mount`; later changes are the run's
  // business, not the frame's. A **viewer** is the exception (apps#370): its
  // value routinely changes after the first render (a live run renders its
  // declared outputs before it has recorded any), and a changed value is
  // re-sent over the live bridge rather than remounting the island.
  const argsRef = useRef(props.arguments)
  const errorRef = useRef(onLoadError)
  const displayRef = useRef(props.display)

  // All three refs are seeded by `useRef` for the first render, so the mount
  // effect below (which runs before this one only on later renders) always
  // reads a current value.
  useEffect(() => {
    argsRef.current = props.arguments
    errorRef.current = onLoadError
    displayRef.current = props.display
  })

  /** Signature of the arguments the island was last told; `null` until mounted. */
  const sentRef = useRef<string | null>(null)

  /** Viewer only: send the current arguments if the island has not had them. */
  const resend = () => {
    const signature = toolInputSignature(argsRef.current)
    if (sentRef.current === null || sentRef.current === signature) return
    sentRef.current = signature
    void host.sendToolInput(argsRef.current).catch(() => {
      // A bridge that went away mid-send is torn down by the cleanup anyway.
    })
  }

  useEffect(() => {
    const iframe = frameRef.current
    if (!iframe) return

    const controller = new AbortController()
    let live = true
    const mountedWith = argsRef.current

    void host
      .mount(iframe, {
        impl,
        src,
        arguments: mountedWith,
        viewer,
        headless,
        signal: controller.signal,
      })
      .then(() => {
        if (!live) return
        // The mode effect below cannot reach a session that did not exist yet
        // when it ran, so a step that opens straight into fullscreen applies it
        // here. Idempotent: `setDisplayMode` no-ops when nothing changed.
        host.setDisplayMode(displayRef.current)
        // A viewer's value may have moved on while the HTML was in flight.
        sentRef.current = toolInputSignature(mountedWith)
        if (viewer) resend()
      })
      .catch((err: unknown) => {
        // A mount the cleanup already abandoned is not a load error.
        if (!live) return
        const message = err instanceof Error ? err.message : String(err)
        errorRef.current({ code: 'ISLAND_LOAD', message })
      })

    return () => {
      live = false
      sentRef.current = null
      controller.abort()
      void host.teardown('unmounted')
    }
    // `resend` closes over refs only; it is stable by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, impl, src, viewer, headless])

  // The viewer half of tool-input: a changed value reaches the mounted island
  // as a fresh `ui/notifications/tool-input`. No-op until the mount resolves
  // (the mount's own `.then` catches up) and always for a step's island.
  const signature = viewer ? toolInputSignature(props.arguments) : null
  useEffect(() => {
    if (viewer) resend()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, viewer, signature])

  // The page's half of `ui/request-display-mode`: the island *asks*, the store
  // decides, and the answer flows back down here. Without it the bridge would
  // keep telling the island it is fullscreen after the user left fullscreen.
  useEffect(() => {
    host.setDisplayMode(props.display)
  }, [host, props.display])

  return (
    <iframe
      ref={frameRef}
      data-testid="island-frame"
      className="island-frame"
      sandbox="allow-scripts"
      allow={buildAllowAttribute(props.permissions)}
      title={props.title ?? props.src}
    />
  )
}
