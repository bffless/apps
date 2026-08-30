export interface StepRow {
  runId?: string; key: string; job: string; index: number; step: string; kind: string; status: string
  outputs?: Record<string, unknown> | null; response?: unknown; inputs?: unknown; error?: unknown
}
export interface RunRow {
  runId: string; status: string; headless?: boolean | null
  outputs?: Record<string, unknown> | null; inputs?: Record<string, unknown> | null; impl?: string; workflow?: string
}
export interface RunRecord { run: RunRow | null; steps: StepRow[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseRecord(json: unknown): RunRecord {
  if (!isObj(json) || !('run' in json)) throw new Error('not a run record: no `run`')
  if (!Array.isArray(json.steps)) throw new Error('not a run record: `steps` is not an array')
  return { run: (json.run as RunRow | null) ?? null, steps: json.steps as StepRow[] }
}

export function stepByKey(rec: RunRecord, key: string): StepRow | undefined {
  return rec.steps.find((s) => s.key === key)
}

export function stepsOfJob(rec: RunRecord, job: string): StepRow[] {
  return rec.steps.filter((s) => s.key.startsWith(`${job}/`)).sort((a, b) => a.index - b.index || a.key.localeCompare(b.key))
}

export function isFileRef(v: unknown): v is { path: string; name: string; contentType: string; size: number; url: string } {
  return isObj(v) && typeof v.path === 'string' && typeof v.name === 'string' && typeof v.contentType === 'string' && typeof v.size === 'number' && typeof v.url === 'string'
}

export function isOffloaded(v: unknown): boolean {
  return isObj(v) && '$file' in v
}
