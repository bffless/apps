import { describe, it, expect } from 'vitest'
import reducer, { setScenes, setDirection, addSavedVoice, freshWorkingState, type StudioState } from './studioSlice'
import {
  createProject, openProject, closeProject, renameProject, deleteProject, resetProject,
} from './studioSlice'
import { selectActive, selectProjectList, EMPTY_WORKING } from './studioSlice'
import { hydrateProject, evictOthers, reconcileServerIndex } from './studioSlice'

const withOneProject = (): StudioState => ({
  index: { p1: { id: 'p1', name: 'A', createdAt: 1, updatedAt: 1, phase: 'import', thumbnailUrl: null } },
  working: { p1: freshWorkingState() },
  activeProjectId: 'p1',
  savedVoices: [],
})

describe('project-scoped reducers route to the active project', () => {
  it('setScenes mutates the active project only', () => {
    const next = reducer(withOneProject(), setScenes([{ id: 'sc1', status: 'pending' } as never]))
    expect(next.working.p1.scenes).toHaveLength(1)
  })
  it('is a no-op when no project is active', () => {
    const empty: StudioState = { index: {}, working: {}, activeProjectId: null, savedVoices: [] }
    const next = reducer(empty, setDirection('hi'))
    expect(next).toEqual(empty)
  })
})

describe('savedVoices live at the root, shared across projects', () => {
  it('addSavedVoice writes to root state, not a project', () => {
    const next = reducer(withOneProject(), addSavedVoice({ voiceId: 'v1', label: 'Mine' }))
    expect(next.savedVoices).toEqual([{ voiceId: 'v1', label: 'Mine' }])
    expect('savedVoices' in next.working.p1).toBe(false)
  })
})

describe('project management', () => {
  it('createProject mints an id, adds index + working, and makes it active', () => {
    const next = reducer(undefined, createProject({ id: 'p1', now: 100 }))
    expect(next.activeProjectId).toBe('p1')
    expect(next.index.p1.name).toBe('Untitled project')
    expect(next.index.p1.createdAt).toBe(100)
    expect(next.working.p1.scenes).toEqual([])
  })
  it('names the second untitled project "Untitled project 2"', () => {
    let s = reducer(undefined, createProject({ id: 'p1', now: 1 }))
    s = reducer(s, createProject({ id: 'p2', now: 2 }))
    expect(s.index.p2.name).toBe('Untitled project 2')
  })
  it('openProject / closeProject move the active pointer', () => {
    let s = reducer(undefined, createProject({ id: 'p1', now: 1 }))
    s = reducer(s, closeProject())
    expect(s.activeProjectId).toBeNull()
    s = reducer(s, openProject('p1'))
    expect(s.activeProjectId).toBe('p1')
  })
  it('renameProject updates the name + updatedAt', () => {
    let s = reducer(undefined, createProject({ id: 'p1', now: 1 }))
    s = reducer(s, renameProject({ id: 'p1', name: 'Cat site', now: 5 }))
    expect(s.index.p1.name).toBe('Cat site')
    expect(s.index.p1.updatedAt).toBe(5)
  })
  it('deleteProject drops index + working and clears active if it was active', () => {
    let s = reducer(undefined, createProject({ id: 'p1', now: 1 }))
    s = reducer(s, deleteProject('p1'))
    expect(s.index.p1).toBeUndefined()
    expect(s.working.p1).toBeUndefined()
    expect(s.activeProjectId).toBeNull()
  })
  it('resetProject clears the active project working state but keeps it in the list', () => {
    let s = reducer(undefined, createProject({ id: 'p1', now: 1 }))
    s = reducer(s, setDirection('hello'))
    s = reducer(s, resetProject())
    expect(s.working.p1.direction).toBe('')
    expect(s.index.p1).toBeDefined()
  })
})

describe('server-sync reducers', () => {
  it('hydrateProject fills working[id] from a server copy', () => {
    let s = reducer(undefined, createProject({ id: 'p1', now: 1 }))
    const w = freshWorkingState(); w.direction = 'srv'
    s = reducer(s, hydrateProject({ id: 'p1', working: w }))
    expect(s.working.p1.direction).toBe('srv')
  })
  it('evictOthers keeps only the active project working state', () => {
    let s = reducer(undefined, createProject({ id: 'a', now: 1 }))
    s = reducer(s, createProject({ id: 'b', now: 2 }))          // active=b; both have working
    s = reducer(s, hydrateProject({ id: 'a', working: freshWorkingState() }))
    s = reducer(s, evictOthers('b'))
    expect(s.working.b).toBeDefined()
    expect(s.working.a).toBeUndefined()
    expect(s.index.a).toBeDefined()   // meta kept
  })
  it('reconcileServerIndex merges server metas (adds server-only, keeps local-only)', () => {
    let s = reducer(undefined, createProject({ id: 'local', now: 9 }))
    s = reducer(s, reconcileServerIndex([{ id: 'srv', name: 'Srv', createdAt: 1, updatedAt: 2, phase: 'prep', thumbnailUrl: null }]))
    expect(s.index.local).toBeDefined()
    expect(s.index.srv.name).toBe('Srv')
  })
})

describe('selectors', () => {
  it('selectActive returns a stable empty working state when none is open', () => {
    const s = { studio: { index: {}, working: {}, activeProjectId: null, savedVoices: [] } } as never
    expect(selectActive(s)).toBe(EMPTY_WORKING)
  })
  it('selectProjectList sorts by updatedAt desc', () => {
    let st = reducer(undefined, createProject({ id: 'p1', now: 1 }))
    st = reducer(st, createProject({ id: 'p2', now: 2 }))
    st = reducer(st, renameProject({ id: 'p1', name: 'x', now: 9 }))
    const list = selectProjectList({ studio: st } as never)
    expect(list.map((m) => m.id)).toEqual(['p1', 'p2'])
  })
})
