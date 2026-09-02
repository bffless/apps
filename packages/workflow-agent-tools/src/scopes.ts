/**
 * Every tool maps to exactly one scope (spec 10, D23), and the catalog owns the
 * map so an OAuth consent screen and `tools/list` tell the same story. On the
 * WebMCP page scopes do not apply — the session is the credential; over the
 * MCP endpoint a token missing the tool's scope is refused before the tool runs.
 */
import type { ToolName } from './catalog.js'

export const SCOPES = ['workflow:read', 'workflow:run', 'workflow:files'] as const
export type Scope = (typeof SCOPES)[number]

export const TOOL_SCOPES: Readonly<Record<ToolName, Scope>> = {
  'workflow.list': 'workflow:read',
  'workflow.describe': 'workflow:read',
  'workflow.status': 'workflow:read',
  'workflow.await': 'workflow:read',
  'workflow.runs': 'workflow:read',
  'workflow.outputs': 'workflow:read',
  'workflow.start': 'workflow:run',
  'workflow.submitStep': 'workflow:run',
  'workflow.cancel': 'workflow:run',
  'workflow.resume': 'workflow:run',
  'workflow.sign': 'workflow:files',
}

/** The scope a (dot- or slash-form) tool name needs; `undefined` for a name outside the catalog. */
export function scopeOf(name: string): Scope | undefined {
  const canonical = name.replace(/\//g, '.')
  return Object.hasOwn(TOOL_SCOPES, canonical) ? TOOL_SCOPES[canonical as ToolName] : undefined
}
