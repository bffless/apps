/**
 * Discovery, for one reason only: to learn which of the workflow's inputs are
 * `file`, so `upload.ts` can turn a local path into a File ref before the page
 * opens. Nothing else here gates the run.
 *
 * That is why every failure below is soft. If the index cannot be read, or the
 * YAML will not parse, the driver still opens the start URL and lets the
 * **page** say what is wrong — `status: 'invalid'` with `workflow` or
 * `discovery` in `errors`, which is the harness's own answer rather than the
 * driver's guess at it.
 */
import { parse as parseYaml } from 'yaml'
import type { ApiLike } from './api.js'
import type { InputDecl } from './upload.js'

export interface WorkflowListing {
  file: string
  name?: string
  description?: string
  headlessSafe?: boolean
}

export interface Definition {
  listing: WorkflowListing
  /** `on.manual.inputs`, or `{}` when the YAML declares none. */
  inputs: Record<string, InputDecl>
}

/** The workflow id of a listing file: the basename minus its workflow suffix (R1). */
export function workflowId(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.workflow\.ya?ml$/i, '').replace(/\.ya?ml$/i, '')
}

/** `/w/<impl>/.bffless/workflows/<file>` — the implementation's published bundle (06). */
export function publishedPath(impl: string, file: string): string {
  return `/w/${impl}/.bffless/workflows/${file}`
}

function declsOf(raw: unknown): Record<string, InputDecl> {
  const doc = (raw ?? {}) as Record<string, unknown>
  const on = (doc.on ?? {}) as Record<string, unknown>
  const manual = (on.manual ?? {}) as Record<string, unknown>
  const inputs = manual.inputs
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) return {}

  const decls: Record<string, InputDecl> = {}
  for (const [name, value] of Object.entries(inputs as Record<string, unknown>)) {
    const d = (value ?? {}) as Record<string, unknown>
    decls[name] = {
      ...(typeof d.type === 'string' ? { type: d.type } : {}),
      ...(d.list === true ? { list: true } : {}),
    }
  }
  return decls
}

/**
 * The workflow's listing and its input declarations, or `undefined` when this
 * side could not work them out — see the note above on why that is not fatal.
 */
export async function fetchDefinition(
  api: ApiLike,
  impl: string,
  workflow: string,
  warn: (line: string) => void = () => {},
): Promise<Definition | undefined> {
  const index = await api.json(publishedPath(impl, 'index.json'))
  if (index.status !== 200) {
    warn(`discovery: ${publishedPath(impl, 'index.json')} answered ${index.status}`)
    return undefined
  }
  const doc = (index.body ?? {}) as Record<string, unknown>
  const workflows = Array.isArray(doc.workflows) ? doc.workflows : []
  const listing = workflows
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => typeof entry.file === 'string')
    .find((entry) => workflowId(entry.file as string) === workflow)

  if (!listing) {
    warn(`discovery: ${impl} publishes no workflow called ${workflow}`)
    return undefined
  }

  const file = listing.file as string
  const yaml = await api.text(publishedPath(impl, file))
  if (yaml.status !== 200) {
    warn(`discovery: ${publishedPath(impl, file)} answered ${yaml.status}`)
    return undefined
  }

  let parsed: unknown
  try {
    parsed = parseYaml(yaml.body)
  } catch (error) {
    warn(`discovery: ${file} is not valid YAML: ${(error as Error).message}`)
    return undefined
  }

  return {
    listing: {
      file,
      ...(typeof listing.name === 'string' ? { name: listing.name } : {}),
      ...(typeof listing.description === 'string' ? { description: listing.description } : {}),
      ...(typeof listing.headlessSafe === 'boolean' ? { headlessSafe: listing.headlessSafe } : {}),
    },
    inputs: declsOf(parsed),
  }
}
