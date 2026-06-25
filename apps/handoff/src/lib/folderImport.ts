/**
 * Folder-import planning for Handoff.
 *
 * `planFolderImport` takes a list of relative file paths (as from a folder-drop
 * or zip extraction) and produces a plan for recreating the folder as a
 * browsable tree of Handoff Folders + Files:
 *
 *   - `dirs`: every distinct ancestor directory across the files, in
 *     PARENT-BEFORE-CHILD order so folder creation is always valid.
 *   - `files`: each file paired with its owning relative dir and display name.
 *   - `hasHtml` / `rootIndexHtml`: drive the "Import as Site?" offer in the UI.
 *
 * Normalisation is delegated to `planSiteUpload` (strip `./`, drop junk, strip a
 * single common top dir) so Site planning and tree planning agree on paths — a
 * folder dropped with its wrapper directory imports its *contents*, matching the
 * Site upload behaviour.
 */

import { planSiteUpload } from './site'

export interface FolderImportFile {
  /** Normalised relative path of the file (e.g. `sub/a.md`). */
  relPath: string
  /** Relative dir that owns the file (`''` = the import root / starting folder). */
  dir: string
  /** Display name of the file (the last path segment). */
  name: string
}

export interface FolderImportPlan {
  /** Unique relative dir paths to create, parent-before-child order. */
  dirs: string[]
  /** Each file plus its owning relative dir + display name. */
  files: FolderImportFile[]
  /** Does any `.html`/`.htm` file exist? Drives the Site offer. */
  hasHtml: boolean
  /** Is there a root `index.html`? Default-suggests Site. */
  rootIndexHtml: boolean
}

const HTML_RE = /\.html?$/i

/** Split a normalised path into its owning dir and last segment (name). */
function splitPath(relPath: string): { dir: string; name: string } {
  const slash = relPath.lastIndexOf('/')
  if (slash === -1) return { dir: '', name: relPath }
  return { dir: relPath.slice(0, slash), name: relPath.slice(slash + 1) }
}

/**
 * Produce a FolderImportPlan from a list of inputs (each with at least a
 * `relPath`). Pure — same normalised paths as `planSiteUpload`.
 */
export function planFolderImport(inputs: { relPath: string }[]): FolderImportPlan {
  // Reuse planSiteUpload's normalisation (./-strip, junk-drop, common-top strip).
  const { files: normalised } = planSiteUpload(inputs)

  const files: FolderImportFile[] = normalised.map(({ relPath }) => {
    const { dir, name } = splitPath(relPath)
    return { relPath, dir, name }
  })

  // Collect every distinct ancestor dir across the files.
  const dirSet = new Set<string>()
  for (const { dir } of files) {
    if (dir === '') continue
    const segments = dir.split('/')
    for (let i = 1; i <= segments.length; i++) {
      dirSet.add(segments.slice(0, i).join('/'))
    }
  }

  // Sort parent-before-child: shallower paths first (a parent always has fewer
  // segments than its children), then lexicographically for determinism.
  const dirs = [...dirSet].sort((a, b) => {
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    if (depthA !== depthB) return depthA - depthB
    return a.localeCompare(b)
  })

  const hasHtml = files.some((f) => HTML_RE.test(f.relPath))
  const rootIndexHtml = files.some((f) => f.relPath === 'index.html')

  return { dirs, files, hasHtml, rootIndexHtml }
}
