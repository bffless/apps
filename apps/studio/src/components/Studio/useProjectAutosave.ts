/**
 * Server-side autosave for the ACTIVE project's working state (story 11d, task 6).
 *
 * Mounted by the keyed-by-projectId Studio workspace (11b): each project gets its
 * own workspace instance, so LEAVING a project unmounts the workspace and fires
 * this hook's cleanup. Responsibilities:
 *  - debounce-save the working state to the server whenever it changes,
 *  - flush a final save on `beforeunload` and on unmount,
 *  - on MOUNT, evict every OTHER project's heavy working state from local memory
 *    (keep only the active one; the server is the source of truth and re-opening
 *    hydrates from it). Eviction on ENTER is idempotent, so it survives React 19
 *    StrictMode's synthetic mount→unmount→mount without ever dropping the active
 *    project's just-hydrated working state (the old self-evict-on-unmount did).
 *  - expose a `{ status, savedAt }` for a small "Saving…/Saved" UI indicator.
 *
 * Pitfalls handled here:
 *  - **No setState after unmount.** The unmount cleanup runs a final save but
 *    must not touch React state (the component is gone). A `mounted` ref gates
 *    every `setStatus`/`setSavedAt`; the cleanup sets `mounted.current = false`
 *    before saving so the save's `.then/.catch` stay silent. In-session
 *    (debounced) saves DO update status — the component is still mounted.
 *  - **Stale closures.** The freshest working/meta is read from a `latest` ref so
 *    the debounce/beforeunload/unmount saves always persist current state without
 *    re-subscribing the effects on every keystroke.
 *  - **No save on hydrate.** A `first` ref skips the initial render so opening a
 *    project doesn't immediately re-save it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '../../store/hooks'
import { selectActive, evictOthers } from '../../store/studioSlice'
import { studioApi } from '../../store/studioApi'
import { toServerRecord } from '../../lib/projectSync'
import { deriveProjectMeta } from '../../lib/projects'

const DEBOUNCE_MS = 1500

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/** Pull a readable message out of an RTK Query / fetch error so a failed save
 *  shows WHY instead of being silently swallowed. */
function saveErrorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    const data = o.data as { error?: unknown; message?: unknown } | undefined
    if (data && typeof data.error === 'string') return data.error
    if (data && typeof data.message === 'string') return data.message
    if (typeof o.error === 'string') return o.error // FETCH_ERROR
    if ('status' in o) return `Save request failed (${String(o.status)})`
  }
  if (e instanceof Error) return e.message
  return 'Save failed'
}

export function useProjectAutosave(projectId: string): {
  status: SaveStatus
  savedAt: number | null
  error: string | null
} {
  const dispatch = useAppDispatch()
  const working = useAppSelector(selectActive)
  const meta = useAppSelector((s) => s.studio.index[projectId])

  const [status, setStatus] = useState<SaveStatus>('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Always read the freshest working/meta from a ref so the debounce/unmount/
  // beforeunload saves persist current state without re-subscribing effects.
  // Refs must not be written during render (react-hooks/refs), so a no-deps
  // effect syncs them after every commit — that's still before any timer fires.
  const latest = useRef({ working, meta })
  useEffect(() => {
    latest.current = { working, meta }
  })

  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fire a save. Stable across renders (reads working/meta from `latest`, only
  // depends on the stable `dispatch`), so the effects below don't re-subscribe
  // on every keystroke. `updateStatus` is false on the unmount/unload paths so
  // we never call setState after the component has unmounted.
  const save = useCallback(
    (updateStatus: boolean) => {
      const { working: w, meta: m } = latest.current
      if (!m) return
      const record = toServerRecord({ ...m, ...deriveProjectMeta(w), updatedAt: Date.now() }, w)
      if (updateStatus && mounted.current) setStatus('saving')
      dispatch(studioApi.endpoints.saveProject.initiate(record))
        .unwrap()
        .then(
          () => {
            if (updateStatus && mounted.current) {
              setStatus('saved')
              setSavedAt(Date.now())
              setError(null)
            }
          },
          (e) => {
            // Don't swallow the failure: surface why so the indicator can show it.
            const msg = saveErrorMessage(e)
            console.warn('[studio] project save failed:', msg, e)
            if (updateStatus && mounted.current) {
              setStatus('error')
              setError(msg)
            }
          },
        )
    },
    [dispatch],
  )

  // Debounce a save on every working-state change, skipping the hydrate render.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => save(true), DEBOUNCE_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [working, save])

  // Flush a final save when the tab/window is closing.
  useEffect(() => {
    const onUnload = () => save(false)
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [save])

  // On MOUNT (entered a project — 11b remounts per projectId): re-arm `mounted`
  // and evict every OTHER project's working state so only the active one is local.
  // Idempotent, so StrictMode's mount→unmount→mount is harmless — and it never
  // evicts the ACTIVE project's working state. The cleanup disarms `mounted` (so
  // post-unmount saves stay silent) and RE-ARMS `first`, so the *next* mount's
  // debounce effect skips its hydrate render again — this is what keeps
  // StrictMode's synthetic remount from firing a spurious save, while a genuine
  // post-mount edit still saves (re-arming in the body would swallow that edit,
  // since this effect commits after the debounce effect).
  useEffect(() => {
    mounted.current = true
    dispatch(evictOthers(projectId))
    return () => {
      mounted.current = false
      first.current = true
    }
  }, [projectId, dispatch])

  // On unmount (left the project): flush a final save. No eviction here — that
  // happens on entry now (above), which is what makes it StrictMode-safe.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
      save(false)
    }
  }, [projectId, save])

  return { status, savedAt, error }
}
