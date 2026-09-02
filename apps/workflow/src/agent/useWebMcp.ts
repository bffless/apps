/**
 * The one App-level effect that makes the harness page a tool surface (spec
 * 10, D21): resolve the registry (native `document.modelContext`, else the
 * polyfill), register every catalog tool once with an `AbortSignal` tied to
 * the effect's cleanup, and bind each to an executor that reads the store
 * **at call time**. Nothing captured here changes as a run progresses, so
 * nothing re-registers and `toolchange` fires exactly twice in a tab's life —
 * once on mount, once on unmount.
 *
 * `navigate` and `location` are mirrored into refs by a dependency-less
 * effect: the registration effect runs once per mount, and the executors read
 * the refs when called, so a route change never re-registers a tool.
 *
 * A registration failure is logged, never thrown — a page whose tools did not
 * register is still a working harness page.
 */
import { useEffect, useRef } from 'react'
import { useStore } from 'react-redux'
import { useLocation, useNavigate } from 'react-router-dom'
import { CATALOG } from '@bffless/workflow-agent-tools'
import type { AppStore } from '../store'
import { createExecutors } from './executors'
import { resolveModelContext } from './registry'
import type { ModelContextLike } from './registry'

export interface UseWebMcpOptions {
  /** Test seam: where the tools go. Read once, on mount. Defaults to `resolveModelContext`. */
  resolve?: () => Promise<ModelContextLike | null>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function useWebMcp(options: UseWebMcpOptions = {}): void {
  const store = useStore() as AppStore
  const navigate = useNavigate()
  const location = useLocation()

  const navigateRef = useRef(navigate)
  const pathnameRef = useRef(location.pathname)
  const resolveRef = useRef(options.resolve ?? resolveModelContext)
  useEffect(() => {
    navigateRef.current = navigate
    pathnameRef.current = location.pathname
  })

  useEffect(() => {
    const controller = new AbortController()
    const executors = createExecutors({
      store,
      navigate: (to) => navigateRef.current(to),
      location: () => ({ pathname: pathnameRef.current }),
    })

    resolveRef.current().then(
      (registry) => {
        if (!registry || controller.signal.aborted) return
        for (const tool of CATALOG) {
          const execute = executors[tool.name]
          // An async wrapper, not `Promise.resolve(...)`: a registry that throws
          // synchronously (a name it refuses, a policy it enforces) must cost
          // that one tool, not every tool after it in the loop.
          ;(async () =>
            registry.registerTool(
              {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
                execute: (args) => execute(isPlainObject(args) ? args : {}),
              },
              { signal: controller.signal },
            ))().catch((error: unknown) => {
            if (!controller.signal.aborted) console.error(`[agent] ${tool.name} was not registered`, error)
          })
        }
      },
      (error: unknown) => console.error('[agent] no WebMCP registry', error),
    )

    return () => controller.abort()
    // Once per mount, by design (see the module comment): the store is the
    // app's singleton and the router values are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
