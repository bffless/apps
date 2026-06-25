/**
 * Sub-folder page for Handoff.
 * Reads the :id param and renders the folder view for that folder.
 */

import { useParams, Navigate } from 'react-router-dom'
import { FolderView } from './FolderView'

export function HandoffFolder() {
  const { id } = useParams<{ id: string }>()
  if (!id) return <Navigate to="/" replace />
  return <FolderView folderId={id} />
}
