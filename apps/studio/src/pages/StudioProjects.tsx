import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'react-redux'
import { PageHero } from '../components/PageHero'
import { Section, Dot } from '../components/Section'
import { ProjectList } from '../components/Studio/ProjectList'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { createProject, deleteProject, renameProject, reconcileServerIndex, freshWorkingState, selectProjectList } from '../store/studioSlice'
import { useDeleteProjectAssetsMutation, useListProjectsQuery, useCreateProjectRecordMutation } from '../store/studioApi'
import type { RootState } from '../store'
import { toServerRecord } from '../lib/projectSync'

export function StudioProjects() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const store = useStore()
  const projects = useAppSelector(selectProjectList)
  // Mount-time clock for "edited X ago" — reading Date.now() in render is impure
  // (react-hooks/purity); a state initializer runs once and keeps render pure.
  const [now] = useState(() => Date.now())
  const [deleteAssets] = useDeleteProjectAssetsMutation()
  const [createRecord] = useCreateProjectRecordMutation()

  const { data: serverList, isFetching, isError } = useListProjectsQuery()

  useEffect(() => {
    if (serverList) dispatch(reconcileServerIndex(serverList))
  }, [serverList, dispatch])

  const onNew = () => {
    const id = crypto.randomUUID()
    const ts = Date.now()
    dispatch(createProject({ id, now: ts }))
    const meta = (store.getState() as RootState).studio.index[id]
    if (meta) void createRecord(toServerRecord(meta, freshWorkingState())) // best-effort; autosave/reconcile catch up if it fails
    navigate(`/project/${id}`)
  }
  const onRename = (id: string, name: string) => dispatch(renameProject({ id, name, now: Date.now() }))
  const onDelete = async (id: string) => {
    try {
      await deleteAssets({ projectId: id }).unwrap()
    } catch {
      // best-effort: orphaned bucket objects aren't fatal; remove the project locally regardless
    }
    dispatch(deleteProject(id))
  }

  return (
    <>
      <PageHero
        eyebrow="EP 09 — Studio · scene producer"
        title={<>Your projects<Dot /></>}
        lead="Each recording you turn into a short video is its own project. Pick up where you left off, or start a new one."
      />
      <Section eyebrow="— Producer" title={<>Projects<Dot /></>} divider={false}>
        {isFetching && projects.length === 0 && (
          <p className="text-ink-soft text-[14px]">Loading projects…</p>
        )}
        {isError && (
          <p className="text-ink-soft text-[14px]">Couldn&apos;t reach the server — showing your local copy.</p>
        )}
        <ProjectList
          projects={projects}
          now={now}
          onNew={onNew}
          onRename={onRename}
          onDelete={onDelete}
        />
      </Section>
    </>
  )
}
