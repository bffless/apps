/**
 * Where the page registers its tools (spec 10, D21): `document.modelContext`
 * is the canonical WebMCP entry point, `navigator.modelContext` the deprecated
 * alias — feature-detect both. When neither exists the page installs
 * `@mcp-b/webmcp-polyfill`, which is inert without a consumer, so the tool
 * surface exists in every Chromium: callable by the `@mcp-b` extension bridge,
 * by a devtools agent's `evaluate_script`, and by the headless driver
 * (`workflow-headless`'s page-tool helpers).
 *
 * `ModelContextLike` is the structural subset the adapter needs — enough to
 * register with an `AbortSignal` and to enumerate — so a test can hand
 * `useWebMcp` a fake and never touch a global.
 */
export interface RegisteredToolInput {
  name: string
  description: string
  inputSchema: object
  annotations?: { readOnlyHint?: boolean }
  execute(args: Record<string, unknown>): Promise<unknown> | unknown
}

export interface RegisteredToolInfo {
  name: string
  description?: string
}

export interface ModelContextLike {
  registerTool(tool: RegisteredToolInput, options?: { signal?: AbortSignal }): Promise<void> | void
  getTools(): Promise<RegisteredToolInfo[]> | RegisteredToolInfo[]
}

declare global {
  interface Document {
    modelContext?: ModelContextLike
  }
  interface Navigator {
    modelContext?: ModelContextLike
  }
}

/** The registry the browser (or an already-installed polyfill) provides, or `null`. */
export function nativeModelContext(): ModelContextLike | null {
  if (typeof document === 'undefined') return null
  return document.modelContext ?? (typeof navigator === 'undefined' ? undefined : navigator.modelContext) ?? null
}

/**
 * Native first; the polyfill when absent (D21: polyfill always). `null` only
 * where there is no document at all, or the polyfill refuses to install — an
 * insecure context, a non-configurable global — which is logged, not thrown:
 * a page with no tool surface is still a working harness page.
 */
export async function resolveModelContext(): Promise<ModelContextLike | null> {
  const native = nativeModelContext()
  if (native) return native
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  try {
    const { initializeWebMCPPolyfill } = await import('@mcp-b/webmcp-polyfill')
    initializeWebMCPPolyfill()
  } catch (error) {
    console.error('[agent] the WebMCP polyfill did not install', error)
    return null
  }
  return nativeModelContext()
}
