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
  host: IslandHost
  onLoadError: (err: { code: 'ISLAND_LOAD'; message: string }) => void
}

export function IslandFrame(props: IslandFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const { host, impl, src, viewer, headless, onLoadError } = props

  // The island is mounted for the identity of the step, not for every render:
  // `arguments` is a fresh object each time the pane re-renders, and re-sending
  // tool input would restart the island under the user's hands. The one
  // `tool-input` a step gets is sent by `mount`; later changes are the run's
  // business, not the frame's.
  const argsRef = useRef(props.arguments)
  const errorRef = useRef(onLoadError)

  // Both refs are seeded by `useRef` for the first render, so the mount effect
  // below (which runs before this one only on later renders) always reads a
  // current value.
  useEffect(() => {
    argsRef.current = props.arguments
    errorRef.current = onLoadError
  })

  useEffect(() => {
    const iframe = frameRef.current
    if (!iframe) return

    const controller = new AbortController()
    let live = true

    void host
      .mount(iframe, {
        impl,
        src,
        arguments: argsRef.current,
        viewer,
        headless,
        signal: controller.signal,
      })
      .catch((err: unknown) => {
        // A mount the cleanup already abandoned is not a load error.
        if (!live) return
        const message = err instanceof Error ? err.message : String(err)
        errorRef.current({ code: 'ISLAND_LOAD', message })
      })

    return () => {
      live = false
      controller.abort()
      void host.teardown('unmounted')
    }
  }, [host, impl, src, viewer, headless])

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
