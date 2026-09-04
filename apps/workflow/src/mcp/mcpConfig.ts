/**
 * The MCP endpoint's rule, rendered — not hand-written (Phase 3 plan, Decision
 * 13). `scripts/build-mcp.mjs` bundles this module, calls it, and writes
 * `rules/api/workflow/mcp/rule.yaml` (CE's `mcp_handler` config: the catalog's
 * descriptors byte for byte, the four app-only tools, the resources) and one
 * small sibling rule per tool under `rules/api/workflow/mcp-tools/`, each with
 * exactly the steps that tool needs and `requiredScopes` from the catalog's map
 * (D19, D23). `bundle.test.ts` compares the committed files to a fresh render.
 */
import { CATALOG, TOOL_SCOPES, type ToolName } from '@bffless/workflow-agent-tools'
import { HOST_TOOLS, HOST_TOOL_SCOPES, stepViewUri, SERVER_VERSION, type HostToolName } from './hostTools'
import { RESOURCES_PATH, STEP_VIEW_RESOURCE_PATH, TOOLS_PATH } from './route'

/** Re-exported so `scripts/build-mcp.mjs`'s `loadConfig()` (which bundles this module and imports it) sees it too. */
export { stepViewUri } from './hostTools'

/** The instructions `initialize` answers with — verbatim the prototype's. */
export const INSTRUCTIONS = `The BFFless Workflow harness: ${CATALOG.length} workflow.* tools to list, describe and watch runs and complete a waiting interactive step (island or form). Pass runId to every run-scoped tool.`

export const SERVER_NAME = 'bffless-workflow'

/** `workflow.submitStep` → `submitStep`: the tool's directory name under mcp-tools/. */
export function shortName(tool: string): string {
  return tool.replace(/^workflow\./, '')
}

export function toolRulePath(tool: string): string {
  return `${TOOLS_PATH}${shortName(tool)}`
}

/** CE's `mcp_handler` config — the `config:` of the endpoint rule's one step. `rev` is the build's `sourceRev()` (apps#587). */
export function mcpHandlerConfig({ rev }: { rev: string }): Record<string, unknown> {
  const uri = stepViewUri(rev)
  const tools: Array<Record<string, unknown>> = CATALOG.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    ...(tool.name === 'workflow.submitStep' ? { _meta: { ui: { resourceUri: uri } } } : {}),
    rule: { path: toolRulePath(tool.name), method: 'POST' },
  }))
  for (const tool of HOST_TOOLS) {
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      visibility: ['app'],
      rule: { path: toolRulePath(tool.name), method: 'POST' },
    })
  }
  return {
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
    tools,
    resources: {
      static: [
        {
          uri,
          name: 'Workflow step view',
          description: 'Mounts a waiting island or form step of a run (spec 10).',
          rule: { path: STEP_VIEW_RESOURCE_PATH },
        },
      ],
      templates: [
        {
          uriTemplate: 'ui://bffless/{impl}/{path+}',
          name: 'island',
          description: 'An island of an implementation, served unchanged from its bundle (spec 04).',
          rule: { path: '/w/{impl}/{path+}' },
        },
      ],
      list: { rule: { path: RESOURCES_PATH, method: 'GET' } },
      csp: { connectDomains: ['$app', '$storage'], resourceDomains: ['$storage'] },
    },
  }
}

/** Which pipeline steps each tool rule needs — the prototype's 24-step chain, split per tool. */
export type StepKey =
  | 'route'
  | 'run'
  | 'steps'
  | 'runs'
  | 'waiting'
  | 'aliases'
  | 'index'
  | 'plan'
  | 'index1'
  | 'index2'
  | 'index3'
  | 'yaml'
  | 'island'
  | 'pipelinePost'
  | 'pipelineGet'
  | 'signed'
  | 'merge'
  | 'update'
  | 'reply'

const RUN_ROWS: StepKey[] = ['run', 'steps']
const DISCOVERY: StepKey[] = ['aliases', 'plan', 'index1', 'index2', 'index3']

export const TOOL_STEPS: Readonly<Record<ToolName | HostToolName, StepKey[]>> = {
  'workflow.list': ['route', ...DISCOVERY, 'reply'],
  'workflow.describe': ['route', 'index', 'plan', 'yaml', 'reply'],
  'workflow.status': ['route', ...RUN_ROWS, 'reply'],
  'workflow.outputs': ['route', ...RUN_ROWS, 'reply'],
  'workflow.runs': ['route', 'runs', 'waiting', 'reply'],
  'workflow.sign': ['route', 'signed', 'reply'],
  'workflow.start': ['route', 'reply'],
  'workflow.await': ['route', 'reply'],
  'workflow.cancel': ['route', 'reply'],
  'workflow.resume': ['route', 'reply'],
  'workflow.submitStep': ['route', ...RUN_ROWS, 'merge', 'update', 'reply'],
  'workflow.submit': ['route', ...RUN_ROWS, 'merge', 'update', 'reply'],
  'workflow.annotate': ['route', ...RUN_ROWS, 'merge', 'update', 'reply'],
  'workflow.pipeline': ['route', ...RUN_ROWS, 'plan', 'pipelinePost', 'pipelineGet', 'reply'],
  'workflow.stepView': ['route', ...RUN_ROWS, 'plan', 'island', 'reply'],
}

export const RESOURCES_STEPS: StepKey[] = ['route', ...DISCOVERY, 'reply']

/** The scope a tool rule's `auth_required` requires: the catalog's map for the model-visible tools, the endpoint's for the app-only four. */
export function toolScope(tool: string): string {
  if (Object.hasOwn(TOOL_SCOPES, tool)) return TOOL_SCOPES[tool as ToolName]
  if (Object.hasOwn(HOST_TOOL_SCOPES, tool)) return HOST_TOOL_SCOPES[tool as HostToolName]
  throw new Error(`no scope for ${tool}`)
}

export const ALL_TOOLS: string[] = [...CATALOG.map((t) => t.name), ...HOST_TOOLS.map((t) => t.name)]
