/**
 * `@bffless/workflow-agent-tools` — the one agent tool catalog both adapters
 * consume (spec 10, D19; ADR-0005). Pure data and pure functions: no DOM, no
 * store, no HTTP. The WebMCP page adapter binds it to the Redux store; the MCP
 * endpoint binds it to `/api/workflow/*`. Neither can drift from the other
 * because neither owns a name, a schema or a result shape of its own.
 */
export const CATALOG_VERSION = 1

export {
  CATALOG,
  TOOL_NAMES,
  canonicalToolName,
  toolByName,
  type JsonSchema,
  type ToolAnnotations,
  type ToolDef,
  type ToolName,
} from './catalog.js'
export {
  type AwaitArgs,
  type DescribeArgs,
  type ListArgs,
  type RunIdArg,
  type RunsArgs,
  type SignArgs,
  type StartArgs,
  type SubmitStepArgs,
  type ToolArgs,
} from './schemas.js'
export { SCOPES, TOOL_SCOPES, scopeOf, type Scope } from './scopes.js'
export {
  errorResult,
  isErrorResult,
  textResult,
  type CallToolResult,
  type TextContent,
} from './results.js'
export {
  ACTIVE_STEP_STATUSES,
  declaredList,
  snapshotFromRows,
  snapshotText,
  type RunRowLike,
  type RunSnapshot,
  type RunStatus,
  type StepRowLike,
  type StepStatus,
  type WaitingStep,
} from './snapshot.js'
export type {
  DescribedInput,
  DescribedJob,
  DescribedOutput,
  DescribedStep,
  WorkflowDescription,
} from './describe.js'
