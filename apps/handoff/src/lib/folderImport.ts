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
 * Paths are normalised by `normaliseFiles` (strip `./`, drop junk) but the
 * dropped folder's own directory is KEPT: importing `mynotes/` into the folder
 * you're viewing recreates `mynotes` there, with its contents as children —
 * not dumped loose into the current folder (issue: folder upload lost its
 * wrapper). Site upload still strips that wrapper, because a site's root *is*
 * its wrapper's contents; `rootIndexHtml` is therefore read off the Site view.
 */

import { normaliseFiles, planSiteUpload } from './site'

/** A planned file: the original input item, plus its owning dir and display name. */
export type FolderImportFile<T extends { relPath: string } = { relPath: string }> = T & {
  /** Relative dir that owns the file (`''` = the import root / starting folder). */
  dir: string
  /** Display name of the file (the last path segment). */
  name: string
}

export interface FolderImportPlan<T extends { relPath: string } = { relPath: string }> {
  /** Unique relative dir paths to create, parent-before-child order. */
  dirs: string[]
  /** Each file plus its owning relative dir + display name. */
  files: FolderImportFile<T>[]
  /** Does any `.html`/`.htm` file exist? Drives the Site offer. */
  hasHtml: boolean
  /** Is there a root `index.html` once the Site wrapper is stripped? Default-suggests Site. */
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
 * `relPath`). Pure. Each input item is carried through onto its planned file, so
 * callers keep whatever they attached to it (the `File` to upload).
 */
export function planFolderImport<T extends { relPath: string }>(inputs: T[]): FolderImportPlan<T> {
  // Normalise (./-strip, junk-drop) but keep the dropped folder's own dir.
  const normalised = normaliseFiles(inputs)

  const files: FolderImportFile<T>[] = normalised.map((item) => {
    const { dir, name } = splitPath(item.relPath)
    return { ...item, dir, name }
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
  // Site semantics: the wrapper dir a Site upload would strip is not part of the
  // site's root, so `mynotes/index.html` still counts as a root index.html here.
  const rootIndexHtml = planSiteUpload(inputs).files.some((f) => f.relPath === 'index.html')

  return { dirs, files, hasHtml, rootIndexHtml }
}
