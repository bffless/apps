/**
 * The page-level refusal strings of spec 07, as `lib/autoStart.ts`'s
 * `START_REFUSALS` publishes them — restated here because the bundle may not
 * import `lib/autoStart` (it reaches into the store's world), and held
 * byte-equal by `refusals.test.ts`. An agent, a driver and a person are never
 * judged differently (D12): the endpoint says exactly what the page says.
 */
export const REFUSALS = {
  discovery: 'The implementations could not be listed',
  noWorkflow: 'No implementation here publishes that workflow',
  fileUnreadable: "This workflow's file could not be fetched",
  doesNotLint: 'This workflow does not validate, so it cannot be run',
} as const

/** The endpoint's own: a run-scoped tool called without the run it needs (spec 10: `runId` is required over the MCP endpoint). */
export const NEED_RUN_ID = 'Pass runId — the MCP endpoint has no current run'
export const NEED_IMPL_WORKFLOW = 'Pass impl and workflow — the MCP endpoint has no current run'
/** The sign rule's own 400, verbatim (`files/sign/post/rule.yaml`; `islands/hostDeps.ts`). */
export const NOT_CONFINED = 'path must be an uploads-relative key under workflows/ with no traversal'

/** A token that lacks the tool's scope (spec 10 D23; Phase 3 plan Decisions 15/26) — CE's own wording, so the endpoint and a sibling rule's 403 read the same. */
export const MISSING_SCOPE = (scopes: readonly string[]): string => `insufficient_scope: missing ${scopes.join(', ')}`
