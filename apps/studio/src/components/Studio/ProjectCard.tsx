import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ProjectMeta } from '../../lib/projects'

const PHASE_LABEL: Record<ProjectMeta['phase'], string> = {
  import: 'Import', prep: 'Prep', build: 'Build', export: 'Export',
}

function editedAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function ProjectCard({
  meta, now, onRename, onDelete,
}: {
  meta: ProjectMeta
  now: number
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(meta.name)
  const href = `/project/${meta.id}`

  return (
    <div className="flex flex-col border rule bg-paper-deep/30 overflow-hidden">
      <Link to={href} className="block aspect-video bg-ink/5">
        {meta.thumbnailUrl
          ? <img src={meta.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          : <span className="meta-label flex h-full items-center justify-center text-ink-soft">No preview</span>}
      </Link>
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="meta-label">{PHASE_LABEL[meta.phase]}</span>
          <span className="text-[12px] text-ink-soft">edited {editedAgo(meta.updatedAt, now)}</span>
        </div>
        {editing ? (
          <input
            autoFocus value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { setEditing(false); if (draft.trim()) onRename(meta.id, draft.trim()) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="w-full border rule bg-paper px-2 py-1 text-[15px]"
          />
        ) : (
          <Link to={href} className="text-left text-[16px] font-medium">
            {meta.name}
          </Link>
        )}
        <div className="mt-1 flex items-center gap-2">
          <button type="button" className="pill-ghost text-[12px]" onClick={() => { setDraft(meta.name); setEditing(true) }}>Rename</button>
          <button
            type="button" className="pill-ghost text-[12px]"
            onClick={() => { if (confirm(`Delete "${meta.name}"? This can't be undone.`)) onDelete(meta.id) }}
          >Delete</button>
        </div>
      </div>
    </div>
  )
}
