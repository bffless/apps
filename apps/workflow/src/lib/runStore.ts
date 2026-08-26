/**
 * `RunStore` — the imperative write half of the run record API (05).
 *
 * `rows.ts` (Task 9) says which columns an event touches; this module is the
 * only place that turns a `PersistWrite` into an actual HTTP call, against the
 * three harness pipelines the write path names: create/patch the run row,
 * upsert a step row, and acquire/heartbeat the lease. Reads stay in RTK Query
 * (`workflowApi.ts`) — this module never reads.
 *
 * Not under the `lib/runner` purity fence (it is IO), but still framework-free:
 * no React/Redux/MSW imports, just `HttpJson`.
 */
import type { HttpJson } from './runner/adapters/pipeline'
import type { RunRow, StepRow } from './runner/rows'
import type { StepKey } from './runner/types'

export interface RunStore {
  createRun(row: RunRow): Promise<void>
  patchRun(id: string, patch: Partial<RunRow>): Promise<void>
  upsertStep(runId: string, key: StepKey, patch: Partial<StepRow>): Promise<void>
  lease(id: string, owner: string, takeover?: boolean): Promise<{ ok: boolean; leaseUntil?: number; heldBy?: string }>
}

/**
 * Deleting a run is the one call here a *person* makes, not the runner — the
 * middleware never reaches for it, and every fake `RunStore` a test builds
 * would otherwise have to stub a method it must never call. So it is its own
 * interface; `createRunStore` returns both.
 */
export interface RunDeleter {
  deleteRun(id: string): Promise<{ files: number; records: number }>
}

/**
 * A non-2xx answer, carrying the status. Deletion's three refusals mean
 * different things to the person who asked — 403 "not yours", 409 "cancel it
 * first", 404 "already gone" — so the status has to survive the rejection
 * instead of being flattened into a message.
 */
export class RunStoreError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'RunStoreError'
    this.status = status
  }
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** POST and parse the JSON body; a non-2xx answer is a rejection, same as a network throw. */
async function post(http: HttpJson, path: string, body: unknown): Promise<unknown> {
  const res = await http(path, { method: 'POST', body })
  if (!res.ok) throw new RunStoreError(`runStore: ${path} answered ${res.status}`, res.status)
  return res.body
}

export function createRunStore(http: HttpJson): RunStore & RunDeleter {
  return {
    async createRun(row) {
      await post(http, '/api/workflow/runs', row)
    },

    async patchRun(id, patch) {
      await post(http, '/api/workflow/run/update', { id, patch })
    },

    async upsertStep(runId, key, patch) {
      await post(http, '/api/workflow/run-step', { runId, key, patch })
    },

    async lease(id, owner, takeover) {
      const body = obj(await post(http, '/api/workflow/run/lease', { id, owner, ...(takeover ? { takeover } : {}) }))
      return {
        ok: body.ok === true,
        ...(typeof body.leaseUntil === 'number' ? { leaseUntil: body.leaseUntil } : {}),
        ...(typeof body.heldBy === 'string' ? { heldBy: body.heldBy } : {}),
      }
    },

    // The rule deletes the run's storage prefix, its `workflow_files` rows, its
    // step rows and the run row. Both sweeps report their count: `files` is the
    // objects removed from storage, `records` the upload rows removed. 0 is a
    // normal answer for a run that produced no files — but `records: 0` beside a
    // non-zero `files` means the record filter stopped matching (it deletes
    // nothing rather than failing), which is the one silent failure here.
    async deleteRun(id) {
      const deleted = obj(obj(await post(http, '/api/workflow/run/delete', { id })).deleted)
      return {
        files: typeof deleted.files === 'number' ? deleted.files : 0,
        records: typeof deleted.records === 'number' ? deleted.records : 0,
      }
    },
  }
}
