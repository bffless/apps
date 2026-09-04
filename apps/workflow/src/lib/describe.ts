/**
 * What `workflow.describe` answers (spec 10, D20): the workflow as an agent
 * reads it before deciding a run can complete without a person. Built off the
 * typed `Definition` the harness already loads; the catalog owns the shape
 * (`WorkflowDescription`) so the MCP endpoint's own builder answers the same.
 *
 * A description is not a run: a form's fields are declared, unevaluated (an
 * `options` expression stays an expression); a live `waitingOn` entry carries
 * the evaluated ones. `headless` is read by the one reader of that spelling
 * (`headlessMode`), so the description and the runner cannot disagree about
 * what a step does without a person.
 */
import { declaredList } from '@bffless/workflow-agent-tools'
import type {
  DescribedInput,
  DescribedJob,
  DescribedOutput,
  DescribedStep,
  WorkflowDescription,
} from '@bffless/workflow-agent-tools'
import type { WorkflowListing } from './coerce'
import { jobOrder } from './runner/graph'
import { headlessMode } from './runner/headless'
import type { Definition, Step } from './runner/types'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describeInput(decl: Record<string, unknown>): DescribedInput {
  const input: DescribedInput = { type: typeof decl.type === 'string' ? decl.type : 'string' }
  if (decl.list === true) input.list = true
  if (decl.required === true) input.required = true
  if (decl.default !== undefined) input.default = decl.default
  if (decl.options !== undefined) input.options = decl.options
  return input
}

function describeOutput(decl: unknown): DescribedOutput {
  if (!isPlainObject(decl)) return {}
  const output: DescribedOutput = {}
  if (typeof decl.type === 'string') output.type = decl.type
  if (decl.list === true) output.list = true
  if (typeof decl.render === 'string') output.render = decl.render
  return output
}

function describeStep(step: Step): DescribedStep {
  const raw: Record<string, unknown> = isPlainObject(step.raw) ? step.raw : {}
  const withDecl = isPlainObject(raw.with) ? raw.with : {}
  const described: DescribedStep = { id: step.id, kind: step.uses }
  if (step.uses === 'island' || step.uses === 'form') {
    const mode = headlessMode(step)
    if (mode !== undefined) described.headless = mode
    if (typeof withDecl.title === 'string' && withDecl.title !== '') described.title = withDecl.title
  }
  if (step.uses === 'island' && isPlainObject(raw.outputs)) described.outputs = raw.outputs
  if (step.uses === 'form' && isPlainObject(withDecl.fields)) described.fields = withDecl.fields
  return described
}

function orderedJobs(def: Definition): string[] {
  try {
    return jobOrder(def)
  } catch {
    // A cyclic definition is unschedulable (and does not lint); declaration order is the honest fallback.
    return Object.keys(def.jobs)
  }
}

export function describeWorkflow(a: {
  impl: string
  workflow: string
  listing: WorkflowListing
  def: Definition
}): WorkflowDescription {
  const raw: Record<string, unknown> = isPlainObject(a.def.raw) ? a.def.raw : {}
  const inputs: Record<string, DescribedInput> = {}
  for (const [name, decl] of Object.entries(a.def.inputs)) inputs[name] = describeInput(decl)
  const outputs: Record<string, DescribedOutput> = {}
  for (const [name, decl] of Object.entries(a.def.outputs)) outputs[name] = describeOutput(decl)
  const jobs: DescribedJob[] = orderedJobs(a.def).flatMap((id) => {
    const job = a.def.jobs[id]
    if (!job) return []
    const described: DescribedJob = { id, needs: [...job.needs], steps: job.steps.map(describeStep) }
    if (typeof job.if === 'string') described.if = job.if
    if (isPlainObject(job.matrix)) described.matrix = job.matrix
    return [described]
  })
  const description = typeof raw.description === 'string' && raw.description !== '' ? raw.description : undefined
  return {
    impl: a.impl,
    workflow: a.workflow,
    name: a.def.name,
    ...(description === undefined ? {} : { description }),
    headlessSafe: a.listing.headlessSafe,
    inputs,
    outputs,
    jobs,
  }
}

/**
 * The one sentence both adapters say about a description. An agent host shows a
 * model `content[0].text` and nothing else, so the names a model needs to act —
 * the inputs with their types/defaults, each interactive step's declared
 * outputs or fields — are in the prose, not only in `structuredContent`.
 */
export function describeText(described: WorkflowDescription): string {
  const inputs = Object.entries(described.inputs).map(([name, input]) => {
    const parts = [`${input.type}${input.list ? '[]' : ''}`]
    if (input.required) parts.push('required')
    if (input.default !== undefined) parts.push(`default ${JSON.stringify(input.default)}`)
    return `${name} (${parts.join(', ')})`
  })
  const interactive = described.jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.kind === 'island' || step.kind === 'form')
      .map((step) => {
        const declared = step.kind === 'island' ? declaredList(step.outputs, 'json') : declaredList(step.fields, 'string')
        const headless = step.headless ? `headless: ${step.headless}` : 'needs a person'
        return `${job.id}/${step.id} (${step.kind}, ${headless}${declared ? `; ${step.kind === 'island' ? 'outputs' : 'fields'}: ${declared}` : ''})`
      }),
  )
  return `${described.name} (${described.impl}/${described.workflow}): ${inputs.length} inputs${inputs.length ? ` — ${inputs.join(', ')}` : ''}; ${described.jobs.length} jobs; ${Object.keys(described.outputs).length} outputs${interactive.length ? `; interactive steps: ${interactive.join(', ')}` : '; no interactive steps'}${described.headlessSafe ? '; headless-safe' : ''}`
}
