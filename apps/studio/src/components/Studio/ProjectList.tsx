import type { ProjectMeta } from '../../lib/projects'
import { ProjectCard } from './ProjectCard'

export function ProjectList({
  projects, now, onNew, onRename, onDelete,
}: {
  projects: ProjectMeta[]
  now: number
  onNew: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[14px] text-ink-soft">
          {projects.length === 0 ? 'No projects yet.' : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
        </p>
        <button type="button" className="pill-cta" onClick={onNew}>+ New project</button>
      </div>
      {projects.length === 0 ? (
        <div className="border rule bg-paper-deep/30 px-6 py-16 text-center">
          <p className="text-[16px] text-ink-soft">Start your first project — upload a recording and the app preps it for you.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((m) => (
            <ProjectCard key={m.id} meta={m} now={now} onRename={onRename} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  )
}
