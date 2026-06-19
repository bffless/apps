import type { ProjectMeta } from './projects'
import type { ProjectWorkingState } from '../store/studioSlice'
import { freshWorkingState } from '../store/studioSlice'

/** Outbound server record: `data` is the stringified working state. */
export type ProjectRecord = ProjectMeta & { data: string }
/** Inbound record from GET: `data` may be a parsed object, a string, or absent. */
export type ProjectRecordIn = ProjectMeta & { data?: unknown }

export const pickNewer = (a: ProjectMeta, b: ProjectMeta): ProjectMeta =>
  b.updatedAt > a.updatedAt ? b : a

/** Merge server metas into the local index: add server-only, refresh by newer
 *  updatedAt, keep local-only (unsynced) entries. */
export function reconcileIndex(
  local: Record<string, ProjectMeta>,
  server: ProjectMeta[],
): Record<string, ProjectMeta> {
  const out: Record<string, ProjectMeta> = { ...local }
  for (const s of server) {
    const l = out[s.id]
    out[s.id] = l ? pickNewer(l, s) : s
  }
  return out
}

const META_KEYS = ['id', 'name', 'createdAt', 'updatedAt', 'phase', 'thumbnailUrl'] as const

export function toServerRecord(meta: ProjectMeta, working: ProjectWorkingState): ProjectRecord {
  return { ...meta, data: JSON.stringify(working) }
}

/** Accepts `data` as a string (we sent it stringified) OR an object (GET returns it
 *  parsed) OR garbage → falls back to a fresh working state. */
export function fromServerRecord(rec: ProjectRecordIn): { meta: ProjectMeta; working: ProjectWorkingState } {
  const meta = {} as ProjectMeta
  for (const k of META_KEYS) (meta as Record<string, unknown>)[k] = rec[k]
  let parsed: unknown = rec.data
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { parsed = null }
  }
  const working: ProjectWorkingState =
    parsed && typeof parsed === 'object'
      ? { ...freshWorkingState(), ...(parsed as Partial<ProjectWorkingState>) }
      : freshWorkingState()
  return { meta, working }
}
