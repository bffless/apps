/**
 * FolderTree — the persistent left-rail navigation (ADR-0004). Lazy-loads each
 * folder's children via the per-parent `listNodes` query (folders only), so the
 * tree is ACL-aware for free: folders the viewer can't list simply never appear.
 * Current folder is highlighted; expand state lives here (the tree is mounted in
 * the Shell, so it persists across folder navigation). In share-link mode the
 * tree is rooted at the shared folder rather than the inaccessible real root.
 */

import { useState, useCallback } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useSelector } from 'react-redux'
import { useListNodesQuery, useGetNodeQuery } from '../store/handoffApi'
import { FolderIcon, ChevronRightIcon } from './icons'
import type { RootState } from '../store'

function currentFolderId(pathname: string): string {
  if (pathname === '/' || pathname === '') return 'root'
  const m = pathname.match(/^\/folder\/(.+)$/)
  return m ? m[1] : '' // viewer / other routes → nothing highlighted
}

interface TreeFolderProps {
  id: string
  name: string
  depth: number
  expanded: Set<string>
  toggle: (id: string) => void
  currentId: string
  /** Root link target differs (root → "/"). */
  rootId: string
}

function TreeFolder({ id, name, depth, expanded, toggle, currentId, rootId }: TreeFolderProps) {
  const isOpen = expanded.has(id)
  const { data: children, isFetching } = useListNodesQuery({ parentId: id }, { skip: !isOpen })
  const folders = (children ?? []).filter((n) => n.type === 'folder')
  const isCurrent = id === currentId
  // Show a caret if we haven't loaded yet (might have children) or we have some.
  const showCaret = !isOpen || folders.length > 0
  const to = id === rootId && rootId === 'root' ? '/' : `/folder/${id}`

  return (
    <li>
      <div
        className={`group flex items-center gap-1 rounded-lg pr-1.5 transition-colors ${
          isCurrent ? 'bg-accent-100 text-accent-700' : 'text-ink hover:bg-surface-2'
        }`}
        style={{ paddingLeft: `${depth * 0.75 + 0.25}rem` }}
      >
        <button
          type="button"
          onClick={() => toggle(id)}
          aria-label={isOpen ? `Collapse ${name}` : `Expand ${name}`}
          aria-expanded={isOpen}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted transition-transform hover:text-ink ${
            showCaret ? '' : 'invisible'
          } ${isOpen ? 'rotate-90' : ''}`}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </button>
        <Link
          to={to}
          className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm no-underline ${
            isCurrent ? 'font-medium' : ''
          }`}
        >
          <FolderIcon className={`h-4 w-4 shrink-0 ${isCurrent ? 'text-accent-600' : 'text-folder'}`} />
          <span className="truncate">{name}</span>
        </Link>
      </div>
      {isOpen && (
        <ul>
          {isFetching && folders.length === 0 && (
            <li className="py-1" style={{ paddingLeft: `${(depth + 1) * 0.75 + 0.5}rem` }}>
              <div className="skeleton h-4 w-24 rounded" />
            </li>
          )}
          {folders.map((f) => (
            <TreeFolder
              key={f.id}
              id={f.id}
              name={f.name}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              currentId={currentId}
              rootId={rootId}
            />
          ))}
          {!isFetching && folders.length === 0 && (
            <li
              className="py-1 text-xs text-muted"
              style={{ paddingLeft: `${(depth + 1) * 0.75 + 0.5}rem` }}
            >
              No sub-folders
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

export function FolderTree() {
  const { pathname } = useLocation()
  const currentId = currentFolderId(pathname)
  const shareLinkFolderId = useSelector((s: RootState) => s.handoff.shareLinkFolderId)
  const rootId = shareLinkFolderId ?? 'root'

  // Name of the shared root (share mode only); root is "Home" otherwise.
  const { data: sharedRoot } = useGetNodeQuery(rootId, { skip: rootId === 'root' })
  const rootName = rootId === 'root' ? 'Home' : (sharedRoot?.name ?? 'Shared folder')

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootId]))
  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <nav aria-label="Folders" className="tree-nav text-sm">
      <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-muted">Folders</p>
      <ul>
        <TreeFolder
          id={rootId}
          name={rootName}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          currentId={currentId}
          rootId={rootId}
        />
      </ul>
    </nav>
  )
}
