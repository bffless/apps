import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import type { Finding } from '../findings.js'
import schema from './workflow-schema.js'

const ajv = new Ajv2020.default({ allErrors: true, allowUnionTypes: true, strict: false })
const validate = ajv.compile(schema)

const STEP_KINDS = ['pipeline', 'island', 'form', 'script'] as const
type StepKind = (typeof STEP_KINDS)[number]

// Per-kind validators so a bad step reports against its own branch instead of
// the 4-way oneOf storm. $defs travel along so intra-schema $refs resolve.
const stepValidators: Record<StepKind, ValidateFunction> = Object.fromEntries(
  STEP_KINDS.map((kind) => [
    kind,
    ajv.compile({ ...schema.$defs[`${kind}Step`], $defs: schema.$defs }),
  ]),
) as Record<StepKind, ValidateFunction>

const STEP_PATH = /^\/jobs\/[^/]+\/steps\/\d+/

function toFinding(err: ErrorObject, basePath = ''): Finding {
  const message =
    err.keyword === 'additionalProperties'
      ? `${err.message} ('${(err.params as { additionalProperty: string }).additionalProperty}')`
      : (err.message ?? err.keyword)
  return {
    rule: 'schema',
    severity: 'error',
    message,
    path: basePath + err.instancePath,
  }
}

export function validateDefinition(data: unknown): Finding[] {
  if (validate(data)) return []
  const errors = validate.errors ?? []

  const findings: Finding[] = []
  const stepPaths = new Set<string>()

  for (const err of errors) {
    const m = STEP_PATH.exec(err.instancePath)
    if (m) {
      stepPaths.add(m[0])
      continue // replaced by the per-branch re-validation below
    }
    findings.push(toFinding(err))
  }

  for (const stepPath of [...stepPaths].sort()) {
    const step = stepPath
      .slice(1)
      .split('/')
      .reduce<any>((o, seg) => (o == null ? undefined : o[seg]), data)
    const uses = step?.uses
    if (typeof uses !== 'string' || !(STEP_KINDS as readonly string[]).includes(uses)) {
      findings.push({
        rule: 'schema',
        severity: 'error',
        message: `uses must be one of: ${STEP_KINDS.join(', ')} (got ${JSON.stringify(uses)})`,
        path: stepPath,
      })
      continue
    }
    const branch = stepValidators[uses as StepKind]
    if (!branch(step)) {
      for (const err of branch.errors ?? []) findings.push(toFinding(err, stepPath))
    }
  }

  // Deduplicate (allErrors can repeat the same complaint through allOf branches).
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = `${f.path}|${f.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
