/**
 * One JSON Schema per tool, and the TypeScript shape each schema describes.
 * The schemas are the wire contract (`tools/list`, `registerTool`); the types
 * are what an executor reads once the host has validated the arguments. They
 * are hand-written side by side rather than generated so the file reads as the
 * spec-10 table it implements.
 *
 * `runId` is optional wherever a *current run* can exist (the WebMCP page has
 * one; the MCP endpoint does not, and there it is required by the adapter, not
 * the schema — the catalog describes the tool, not the surface).
 */
import type { JsonSchema } from './catalog.js'

const RUN_ID = {
  type: 'string',
  description: 'The run to act on. Optional where a current run exists (the harness page); required over the MCP endpoint.',
} as const

const IMPL = { type: 'string', description: 'The implementation alias, e.g. `hello`.' } as const
const WORKFLOW = {
  type: 'string',
  description: 'The workflow id — the file base name minus `.workflow.yaml`, e.g. `interactive`.',
} as const

export interface ListArgs {
  impl?: string
}
export const LIST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { impl: { ...IMPL, description: 'Only this implementation.' } },
  required: [],
  additionalProperties: false,
}

export interface DescribeArgs {
  impl: string
  workflow: string
}
export const DESCRIBE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { impl: IMPL, workflow: WORKFLOW },
  required: ['impl', 'workflow'],
  additionalProperties: false,
}

export interface StartArgs {
  impl: string
  workflow: string
  inputs: Record<string, unknown>
}
export const START_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    impl: IMPL,
    workflow: WORKFLOW,
    inputs: {
      type: 'object',
      description:
        'Values for `on.manual.inputs`, keyed by input name. An omitted input takes its declared default; a `file` input is a whole File ref (`{ path, name, contentType, size, url }`), never a bare path or a URL. Pass `{}` for a workflow with no inputs.',
      additionalProperties: true,
    },
  },
  required: ['impl', 'workflow', 'inputs'],
  additionalProperties: false,
}

export interface RunIdArg {
  runId?: string
}
export const STATUS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { runId: RUN_ID },
  required: [],
  additionalProperties: false,
}
export const OUTPUTS_SCHEMA: JsonSchema = STATUS_SCHEMA
export const CANCEL_SCHEMA: JsonSchema = STATUS_SCHEMA

export interface AwaitArgs {
  runId?: string
  until: 'waiting' | 'terminal'
  timeoutMs?: number
}
export const AWAIT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    runId: RUN_ID,
    until: {
      type: 'string',
      enum: ['waiting', 'terminal'],
      description:
        '`waiting`: resolve as soon as the run needs input (a step is `waiting`) or ends; `terminal`: resolve only when the run ends.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: 600000,
      description: 'How long to wait before answering with the current snapshot and `timedOut: true` (default 120000).',
    },
  },
  required: ['until'],
  additionalProperties: false,
}

export interface RunsArgs {
  impl?: string
  workflow?: string
  status?: 'running' | 'succeeded' | 'failed' | 'cancelled'
  limit?: number
}
export const RUNS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    impl: { ...IMPL, description: 'The implementation alias; defaults to the current run’s (or the page’s) on the harness page.' },
    workflow: { ...WORKFLOW, description: 'The workflow id; defaults to the current run’s (or the page’s) on the harness page.' },
    status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'cancelled'], description: 'Only runs in this status.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'At most this many runs, newest first (default 20).' },
  },
  required: [],
  additionalProperties: false,
}

export interface SubmitStepArgs {
  runId?: string
  step: string
  values: Record<string, unknown>
}
export const SUBMIT_STEP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    runId: RUN_ID,
    step: { type: 'string', description: 'The waiting step’s key, `<job>/<index>/<step>` — as listed in the snapshot’s `waitingOn`.' },
    values: {
      type: 'object',
      description:
        'For a `form` step: a value per field, keyed by field name (a `choice` over File refs takes the ref’s `path`). For an `island` step: the step’s declared outputs, keyed by output name.',
      additionalProperties: true,
    },
  },
  required: ['step', 'values'],
  additionalProperties: false,
}

export interface SignArgs {
  runId?: string
  path: string
}
export const SIGN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    runId: RUN_ID,
    path: {
      type: 'string',
      description: 'A File ref’s `path` — an uploads-relative key under `workflows/`. Nothing else is signable.',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

export const RESUME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { runId: { ...RUN_ID, description: 'The `running` run to take over.' } },
  required: ['runId'],
  additionalProperties: false,
}

/** Each tool name → the arguments its executor receives once the host validated them against the schema. */
export interface ToolArgs {
  'workflow.list': ListArgs
  'workflow.describe': DescribeArgs
  'workflow.start': StartArgs
  'workflow.status': RunIdArg
  'workflow.await': AwaitArgs
  'workflow.runs': RunsArgs
  'workflow.submitStep': SubmitStepArgs
  'workflow.outputs': RunIdArg
  'workflow.sign': SignArgs
  'workflow.cancel': RunIdArg
  'workflow.resume': { runId: string }
}
