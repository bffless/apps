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

/**
 * The harness's own `/api/*` rules, one scope each (spec 10 D23; Phase 3 plan
 * Decision 27). Keyed by the rule's directory under `rules/api/` with its method
 * (`workflow/runs/post`, `uploads/workflows/[...path]/get`), which is how the
 * rule set's fence test looks a rule up — the rule set declares
 * `requiredScopes: [<this>]` and the fence holds the two equal, so the map and
 * the rules cannot drift. Phase 4's `workflow.http` inherits whichever rule it
 * reaches, which is why every rule is here, `aliases/get` included (a forwarder
 * with no validators: recorded, not enforced).
 */
export const RULE_SCOPES: Readonly<Record<string, Scope>> = {
  'workflow/runs/get': 'workflow:read',
  'workflow/run/get': 'workflow:read',
  'workflow/whoami/get': 'workflow:read',
  'workflow/project/get': 'workflow:read',
  'workflow/aliases/get': 'workflow:read',
  'workflow/runs/post': 'workflow:run',
  'workflow/run/update/post': 'workflow:run',
  'workflow/run-step/post': 'workflow:run',
  'workflow/run/lease/post': 'workflow:run',
  'workflow/run/delete/post': 'workflow:run',
  'workflow/run/fork/post': 'workflow:run',
  'workflow/files/prepare/post': 'workflow:files',
  'workflow/files/register/post': 'workflow:files',
  'workflow/files/sign/post': 'workflow:files',
  'uploads/workflows/[...path]/get': 'workflow:files',
}

/** The scope a harness rule requires, by its `rules/api/<dir>/<method>` key; `undefined` for a rule outside the map. */
export function ruleScopeOf(ruleKey: string): Scope | undefined {
  return Object.hasOwn(RULE_SCOPES, ruleKey) ? RULE_SCOPES[ruleKey] : undefined
}
