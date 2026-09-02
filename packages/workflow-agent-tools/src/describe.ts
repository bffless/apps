/**
 * What `workflow.describe` answers (spec 10, D20): the workflow as an agent
 * needs to read it before starting a run — inputs, outputs, the job/step graph
 * in dependency order, and per interactive step its `headless` declaration.
 *
 * Types only. The harness builds one from its typed `Definition`
 * (`src/lib/describe.ts`); the MCP endpoint will build one from the published
 * YAML. Both produce this shape, so a model reads the same description whichever
 * surface it asked.
 */
export interface DescribedInput {
  type: string
  list?: boolean
  required?: boolean
  default?: unknown
  /** A `choice` input's allowed values, as declared (a literal list, or an expression string). */
  options?: unknown
}

export interface DescribedOutput {
  type?: string
  list?: boolean
  render?: string
}

export interface DescribedStep {
  id: string
  kind: 'pipeline' | 'island' | 'form' | 'script'
  /** Islands and forms only: what the step does without a person (07). Absent = it waits for one. */
  headless?: 'skip' | 'auto'
  /** An island's declared output map, as declared. */
  outputs?: Record<string, unknown>
  /** A form's fields, as declared (unevaluated — a description is not a run). */
  fields?: Record<string, unknown>
  /** A form's or island's `with.title`, when declared. */
  title?: string
}

export interface DescribedJob {
  id: string
  needs: string[]
  if?: string
  matrix?: Record<string, unknown>
  steps: DescribedStep[]
}

export interface WorkflowDescription {
  impl: string
  workflow: string
  name: string
  description?: string
  /** Every interactive step declares `headless:` — the listing's mark (06/07). */
  headlessSafe: boolean
  inputs: Record<string, DescribedInput>
  outputs: Record<string, DescribedOutput>
  /** In scheduling (topological) order. */
  jobs: DescribedJob[]
}
