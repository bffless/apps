/**
 * The pure halves of the `mcp` walk's checks, kept out of `walks/mcp.ts` so
 * they can be unit-tested without a harness.
 */
import type { ToolDef } from '@bffless/workflow-agent-tools'

export interface ListedTool {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
  _meta?: { ui?: { resourceUri?: string; visibility?: string[] } }
}

/** Stable JSON: keys sorted at every level, so two objects compare as data, not as insertion order. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/**
 * D19: the first `catalog.length` listed tools must equal the catalog's
 * `{ name, description, inputSchema, annotations }` byte for byte. Answers
 * the first mismatch as a sentence, or `[]` when there is none.
 */
export function toolParity(listed: ListedTool[], catalog: readonly ToolDef[]): string[] {
  const problems: string[] = []
  if (listed.length < catalog.length) problems.push(`tools/list has ${listed.length} tools, the catalog ${catalog.length}`)
  for (let i = 0; i < Math.min(listed.length, catalog.length); i++) {
    const wire = listed[i]
    const tool = catalog[i]
    if (!wire || !tool) break
    if (wire.name !== tool.name) {
      problems.push(`tool ${i}: ${wire.name} ≠ ${tool.name}`)
      continue
    }
    for (const field of ['description', 'inputSchema', 'annotations'] as const) {
      if (canonical(wire[field]) !== canonical(tool[field])) problems.push(`${tool.name}.${field} differs`)
    }
  }
  return problems
}

/** The `_meta.ui.csp` arrays of a listed resource or a read content block. */
export function cspOf(entry: unknown): { connectDomains: string[]; resourceDomains: string[] } | null {
  const meta = (entry as { _meta?: { ui?: { csp?: { connectDomains?: unknown; resourceDomains?: unknown } } } } | null)?._meta
  const csp = meta?.ui?.csp
  if (!csp) return null
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
  return { connectDomains: strings(csp.connectDomains), resourceDomains: strings(csp.resourceDomains) }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** `apps/workflow/src/mcp/hostTools.ts`'s pattern, restated: the walks never import the app. */
export const STEP_VIEW_URI_PATTERN = /^ui:\/\/bffless\/workflow\/step-view\.[0-9a-f]{8}\.html$/

/** The step view's URI as `tools/list` carries it on `workflow.submitStep` (apps#587), `''` when absent. */
export function stepViewUriOf(listed: ListedTool[]): string {
  return listed.find((tool) => tool.name === 'workflow.submitStep')?._meta?.ui?.resourceUri ?? ''
}
