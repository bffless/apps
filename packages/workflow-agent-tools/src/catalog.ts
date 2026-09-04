/**
 * The catalog (spec 10 §The tool catalog): eleven `workflow.*` tools — the
 * generic verbs an agent needs to drive a run on a member's behalf, plus
 * `describe`, which is what it reads before deciding a run can complete
 * without a person (D20). Names are dot-canonical and slash-tolerant, exactly
 * as island tool names are (04): the registered name is the dot form only, and
 * `canonicalToolName` folds the slash form back onto it.
 *
 * Deliberately absent (spec 10): `fork`, `retry`, `annotate`, `delete`, and
 * every pipeline of an implementation — an agent completes an island step with
 * `workflow.submitStep`; it does not do the island's job (D21).
 */
import {
  AWAIT_SCHEMA,
  CANCEL_SCHEMA,
  DESCRIBE_SCHEMA,
  LIST_SCHEMA,
  OUTPUTS_SCHEMA,
  RESUME_SCHEMA,
  RUNS_SCHEMA,
  SIGN_SCHEMA,
  START_SCHEMA,
  STATUS_SCHEMA,
  SUBMIT_STEP_SCHEMA,
} from './schemas.js'
import { TOOL_SCOPES } from './scopes.js'
import type { Scope } from './scopes.js'

/** A JSON Schema object — the subset MCP and WebMCP hosts read. Kept loose on purpose: the catalog is data, not a validator. */
export type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }

export const TOOL_NAMES = [
  'workflow.list',
  'workflow.describe',
  'workflow.start',
  'workflow.status',
  'workflow.await',
  'workflow.runs',
  'workflow.submitStep',
  'workflow.outputs',
  'workflow.sign',
  'workflow.cancel',
  'workflow.resume',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/** WebMCP/MCP annotations the catalog sets. `readOnlyHint` lets a consenting browser grant the read tools more cheaply. */
export interface ToolAnnotations {
  readOnlyHint: boolean
}

export interface ToolDef {
  name: ToolName
  description: string
  inputSchema: JsonSchema
  annotations: ToolAnnotations
  scope: Scope
}

const DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  'workflow.list':
    'List the implementations published to this harness and their workflows, each with its `headlessSafe` mark (whether every interactive step declares what to do without a person).',
  'workflow.describe':
    'Describe one workflow before deciding a run can complete without a person: its inputs (types, required, defaults), its outputs, the job/step graph in dependency order, and each interactive step’s `headless` declaration.',
  'workflow.start':
    'Start a run of a workflow with the given inputs. Validated exactly as the kickoff form validates a person’s values; a refusal names each bad input. Returns the run id and its first snapshot, and moves the page to the run.',
  'workflow.status':
    'The run snapshot: status, the steps in flight, every reached step’s status, the outputs so far, and `waitingOn` — for each waiting step what would satisfy it (its kind, its evaluated inputs, an island’s declared outputs and src).',
  'workflow.await':
    'Wait until the run needs input (`until: "waiting"`) or ends (`until: "terminal"`), then return its snapshot. The polite alternative to polling `workflow.status`.',
  'workflow.runs': 'Past runs of one workflow, newest first: id, status, when it started and ended, and which steps it is waiting on.',
  'workflow.submitStep':
    'Complete a waiting interactive step, or open it for the person. A `form` step takes a value per field; an `island` step takes its declared outputs. Validated by the same checks a person’s submit runs; a refusal names each bad value. In an agent host that renders this tool’s UI, call it with `values: {}` for an island or form step: the step’s own UI is shown and the person completes it there — do not invent values for them.',
  'workflow.outputs': 'The run’s outputs — File refs (`{ path, name, contentType, size, url }`), never bytes.',
  'workflow.sign':
    'Exchange a File ref’s `path` for a short-lived presigned GET URL (`{ url, expiresIn }`), the same one islands get to show media.',
  'workflow.cancel': 'Cancel the run. Server-side pipeline jobs already enqueued keep running.',
  'workflow.resume':
    'Take over a `running` run whose driver went away (an expired lease) so this surface drives it from here — how an agent adopts a run another tab or host abandoned.',
}

const SCHEMAS: Readonly<Record<ToolName, JsonSchema>> = {
  'workflow.list': LIST_SCHEMA,
  'workflow.describe': DESCRIBE_SCHEMA,
  'workflow.start': START_SCHEMA,
  'workflow.status': STATUS_SCHEMA,
  'workflow.await': AWAIT_SCHEMA,
  'workflow.runs': RUNS_SCHEMA,
  'workflow.submitStep': SUBMIT_STEP_SCHEMA,
  'workflow.outputs': OUTPUTS_SCHEMA,
  'workflow.sign': SIGN_SCHEMA,
  'workflow.cancel': CANCEL_SCHEMA,
  'workflow.resume': RESUME_SCHEMA,
}

/** The eleven tools, in `TOOL_NAMES` order. Frozen: adapters read it, never edit it. */
export const CATALOG: readonly ToolDef[] = Object.freeze(
  TOOL_NAMES.map((name) =>
    Object.freeze({
      name,
      description: DESCRIPTIONS[name],
      inputSchema: SCHEMAS[name],
      annotations: Object.freeze({ readOnlyHint: TOOL_SCOPES[name] === 'workflow:read' }),
      scope: TOOL_SCOPES[name],
    }),
  ),
)

/** `workflow/submitStep` → `workflow.submitStep`; a name with no `/` is returned as-is. */
export function canonicalToolName(name: string): string {
  return name.replace(/\//g, '.')
}

const BY_NAME = new Map<string, ToolDef>(CATALOG.map((tool) => [tool.name, tool]))

/** The tool a (dot- or slash-form) name denotes; `undefined` outside the catalog. */
export function toolByName(name: string): ToolDef | undefined {
  return BY_NAME.get(canonicalToolName(name))
}
