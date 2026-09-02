/**
 * What `tools/list` answers (spec 10, D19): the catalog, verbatim, plus the
 * four **app-only** tools the step view calls on an island's behalf (Phase 2
 * plan, Decision 4). App-only tools carry `_meta.ui.visibility: ["app"]` — the
 * MCP Apps extension's way of saying "callable by the embedded UI, hidden
 * from the model" — and `workflow.submitStep` links the step view through
 * `_meta.ui.resourceUri`, so a call to it renders the UI that completes it.
 *
 * The catalog owns every model-visible tool; nothing here re-declares one.
 * `workflow.sign` in particular is *not* duplicated: the island calls the
 * catalog's `workflow.sign { runId?, path }` and the endpoint serves it for
 * both audiences.
 */
import { CATALOG, type JsonSchema } from '@bffless/workflow-agent-tools'

/**
 * The endpoint's `serverInfo.version` — the *host protocol* version, the same
 * number `IslandHost`'s `HOST_INFO` announces on `ui/initialize`, because an
 * island served through this endpoint meets the same host surface. Bump both
 * together when that surface changes.
 */
export const SERVER_VERSION = '1.0.0'

/** The engine-less host page that mounts a waiting island inside an agent host (plan Decision 3). */
export const STEP_VIEW_URI = 'ui://bffless/workflow/step.html'

/** Every ui:// resource's MIME type (MCP Apps, `io.modelcontextprotocol/ui`). */
export const RESOURCE_MIME = 'text/html;profile=mcp-app'

export type HostToolName = 'workflow.submit' | 'workflow.annotate' | 'workflow.pipeline' | 'workflow.stepView'

export interface HostToolDef {
  name: HostToolName
  description: string
  inputSchema: JsonSchema
  _meta: { ui: { visibility: ['app'] } }
}

const RUN_ID = { type: 'string', description: 'The run the island belongs to.' } as const
const STEP = { type: 'string', description: 'The step key, `<job>/<index>/<step>`, of the waiting island step.' } as const
const APP_ONLY = { ui: { visibility: ['app'] as ['app'] } }

export const HOST_TOOLS: readonly HostToolDef[] = Object.freeze([
  {
    name: 'workflow.submit',
    description:
      "Complete the waiting island step of a run with its declared outputs — the island's own `workflow.submit` (spec 04), answered server-side: validated against the step's declared output map exactly as the harness page validates it, then written to the step row. Refused while a harness tab still drives the run.",
    inputSchema: {
      type: 'object',
      properties: { runId: RUN_ID, step: STEP, outputs: { type: 'object', description: 'The values for the step’s declared outputs.', additionalProperties: true } },
      required: ['runId', 'step', 'outputs'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'workflow.annotate',
    description:
      "Record annotations and/or a summary on the waiting island step — the island's own `workflow.annotate` (spec 04), budgeted per step exactly as on the harness page.",
    inputSchema: {
      type: 'object',
      properties: {
        runId: RUN_ID,
        step: STEP,
        annotations: { type: 'array', description: 'Entries of `{ level: notice|warning|error, message, title? }`.', items: { type: 'object', additionalProperties: true } },
        summary: { type: 'string' },
      },
      required: ['runId', 'step'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'workflow.pipeline',
    description:
      "Call one of the run's own implementation's pipelines on the island's behalf — a tool name resolves to `/api/<impl>/<path>` (dots as slashes) and is fenced to that implementation exactly as on the harness page (spec 04).",
    inputSchema: {
      type: 'object',
      properties: {
        runId: RUN_ID,
        step: STEP,
        name: { type: 'string', description: 'The pipeline’s tool name, e.g. `echo` or `video.slice`.' },
        arguments: { type: 'object', description: 'The JSON body (POST) or query (GET).', additionalProperties: true },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'Defaults to POST.' },
      },
      required: ['runId', 'step', 'name'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
  {
    name: 'workflow.stepView',
    description:
      "What the step view needs to mount a waiting island: the island HTML (unchanged, fetched from the implementation's bundle), the step's persisted inputs (its tool-input arguments), and its declared outputs.",
    inputSchema: {
      type: 'object',
      properties: { runId: RUN_ID, step: STEP },
      required: ['runId', 'step'],
      additionalProperties: false,
    },
    _meta: APP_ONLY,
  },
])

const HOST_TOOL_NAMES = new Set<string>(HOST_TOOLS.map((tool) => tool.name))

export function isHostTool(name: string): name is HostToolName {
  return HOST_TOOL_NAMES.has(name)
}

/**
 * The `tools/list` result's `tools`: the catalog — `{ name, description,
 * inputSchema, annotations }`, never `scope` (the consent screen's, not the
 * wire's) — with `workflow.submitStep` linking the step view, then the four
 * app-only tools.
 */
export function listedTools(): Array<Record<string, unknown>> {
  const catalog = CATALOG.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    ...(tool.name === 'workflow.submitStep' ? { _meta: { ui: { resourceUri: STEP_VIEW_URI } } } : {}),
  }))
  return [...catalog, ...HOST_TOOLS.map((tool) => ({ ...tool }))]
}
