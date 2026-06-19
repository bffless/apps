import type { Middleware } from '@reduxjs/toolkit'
import { deriveProjectMeta } from '../lib/projects'
import type { StudioState } from './studioSlice'

/** Project-management actions manage `index` themselves — skip them so we don't
 *  clobber createdAt/name or re-stamp on open/close. Also skip the sync action
 *  itself so it never recurses. Server-driven state writes (hydrateProject,
 *  reconcileServerIndex) must also be skipped: they carry the authoritative
 *  server timestamp and must not be overwritten by a local Date.now() stamp,
 *  which would make an unedited local copy wrongly "win" a later reconcile. */
const SKIP = new Set([
  'studio/createProject',
  'studio/openProject',
  'studio/closeProject',
  'studio/renameProject',
  'studio/deleteProject',
  'studio/_syncMeta',
  'studio/hydrateProject',
  'studio/reconcileServerIndex',
])

/** After a working-state mutation, refresh the active project's denormalized
 *  index metadata (phase, thumbnail, updatedAt) so the list stays render-ready. */
export const projectMetaSync: Middleware = (store) => (next) => (action) => {
  const result = next(action)
  const type = (action as { type?: string }).type
  if (typeof type === 'string' && type.startsWith('studio/') && !SKIP.has(type)) {
    const studio = (store.getState() as { studio: StudioState }).studio
    const id = studio.activeProjectId
    const meta = id ? studio.index[id] : undefined
    const working = id ? studio.working[id] : undefined
    if (id && meta && working) {
      const { phase, thumbnailUrl } = deriveProjectMeta(working)
      store.dispatch({ type: 'studio/_syncMeta', payload: { id, phase, thumbnailUrl, now: Date.now() } })
    }
  }
  return result
}
