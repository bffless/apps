import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import studioReducer, {
  createProject, setContactSheets, addSource,
  hydrateProject, reconcileServerIndex, freshWorkingState,
} from './studioSlice'
import { projectMetaSync } from './projectMetaSync'

function makeStore() {
  return configureStore({
    reducer: { studio: studioReducer },
    middleware: (gdm) => gdm().concat(projectMetaSync),
  })
}

describe('projectMetaSync', () => {
  it('refreshes the active project meta after a working-state change', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const store = makeStore()
    store.dispatch(createProject({ id: 'p1', now: 1 }))
    store.dispatch(setContactSheets([{ url: '/api/uploads/thumbnails/x.png' } as never]))
    const meta = store.getState().studio.index.p1
    expect(meta.thumbnailUrl).toBe('/api/uploads/thumbnails/x.png')
    expect(meta.updatedAt).toBe(100)
    vi.restoreAllMocks()
  })

  it('updates the index phase as the project progresses', () => {
    const store = makeStore()
    store.dispatch(createProject({ id: 'p1', now: 1 }))
    expect(store.getState().studio.index.p1.phase).toBe('import')
    store.dispatch(addSource({ id: 's1', fileName: 'a.mp4', duration: 10 }))
    expect(store.getState().studio.index.p1.phase).toBe('prep')
  })

  it('ignores non-studio actions and the create/open/rename/delete actions themselves', () => {
    const store = makeStore()
    store.dispatch(createProject({ id: 'p1', now: 1 }))
    const before = store.getState().studio.index.p1.updatedAt
    store.dispatch({ type: 'other/thing' })
    expect(store.getState().studio.index.p1.updatedAt).toBe(before)
  })

  it('hydrateProject does not bump updatedAt (server-driven write must not restamp)', () => {
    const store = makeStore()
    store.dispatch(createProject({ id: 'p1', now: 1 }))
    const before = store.getState().studio.index.p1.updatedAt
    const w = freshWorkingState(); w.direction = 'from-server'
    store.dispatch(hydrateProject({ id: 'p1', working: w }))
    expect(store.getState().studio.index.p1.updatedAt).toBe(before)
  })

  it('reconcileServerIndex does not bump updatedAt (server-driven write must not restamp)', () => {
    const store = makeStore()
    store.dispatch(createProject({ id: 'p1', now: 1 }))
    const before = store.getState().studio.index.p1.updatedAt
    store.dispatch(reconcileServerIndex([{ id: 'p1', name: 'A', createdAt: 1, updatedAt: 1, phase: 'import', thumbnailUrl: null }]))
    expect(store.getState().studio.index.p1.updatedAt).toBe(before)
  })
})
