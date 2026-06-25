/**
 * Root listing page for Handoff — renders the root folder view.
 * The full listing logic lives in FolderView; this is just a thin wrapper.
 */

import { FolderView } from './FolderView'

export function HandoffHome() {
  return <FolderView folderId="root" />
}
