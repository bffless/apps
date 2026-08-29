export type StepKind = 'pipeline' | 'island' | 'form' | 'script'

export interface InputDef {
  type: string
  list?: boolean
  required?: boolean
  default?: unknown
  options?: unknown
  render?: string
  src?: string
  [k: string]: unknown
}

/** A job/step/top-level output: bare expression string, or the typed object form. */
export type OutputDecl =
  | string
  | {
      type?: string
      list?: boolean
      value?: unknown
      render?: string
      src?: string
      options?: unknown
      schema?: unknown
      /** `markdown` only: `{ [src]: path | FileRef }` — an expression or a literal map (02). */
      images?: unknown
      [k: string]: unknown
    }

export interface Step {
  id: string
  index: number
  uses: StepKind
  raw: any
}

export interface Job {
  id: string
  needs: string[]
  if?: string
  matrix?: Record<string, unknown>
  steps: Step[]
  outputs: Record<string, OutputDecl>
  raw: any
}

export interface Definition {
  name: string
  inputs: Record<string, InputDef>
  jobs: Record<string, Job>
  outputs: Record<string, OutputDecl>
  raw: any
}

/** Typed view over schema-valid data. Assumes validateDefinition() passed. */
export function toDefinition(data: any): Definition {
  const jobs: Record<string, Job> = {}
  for (const [id, raw] of Object.entries<any>(data.jobs ?? {})) {
    jobs[id] = {
      id,
      needs: raw.needs == null ? [] : Array.isArray(raw.needs) ? raw.needs : [raw.needs],
      if: raw.if,
      matrix: raw.strategy?.matrix,
      steps: (raw.steps ?? []).map(
        (s: any, index: number): Step => ({ id: s.id, index, uses: s.uses, raw: s }),
      ),
      outputs: raw.outputs ?? {},
      raw,
    }
  }
  return {
    name: data.name,
    inputs: data.on?.manual?.inputs ?? {},
    jobs,
    outputs: data.outputs ?? {},
    raw: data,
  }
}

/** Declared output names of a step, resolving each kind's convention (03). */
export function stepOutputNames(step: Step): string[] | undefined {
  if (step.uses === 'form') {
    const fields = step.raw.with?.fields
    return fields ? Object.keys(fields) : []
  }
  if (step.raw.outputs) return Object.keys(step.raw.outputs)
  // A pipeline step with no outputs map exposes exactly `response` (03).
  if (step.uses === 'pipeline') return ['response']
  return undefined
}
