/**
 * Site upload planning utilities for Handoff.
 *
 * `planSiteUpload` takes a list of relative file paths (as from a folder-drop
 * or zip extraction) and normalises them into a canonical plan:
 *
 *   1. Normalise paths — strip `./` prefix, drop empty / `.`-ish entries.
 *   2. Folder-drop wrapping — if ALL files share a single common top-level
 *      directory, strip it (e.g. `mysite/index.html` → `index.html`).
 *   3. Entry detection:
 *      - If a root `index.html` exists → entry = 'index.html', candidates = [].
 *      - Else if exactly ONE `*.html` or `*.htm` file exists → that is entry.
 *      - Else → entry = null, candidates = [all html/htm files].
 */

export interface SitePlan {
  /** Normalised file list (same order, post-normalisation). */
  files: { relPath: string }[]
  /** The chosen entry-point HTML file, or null if ambiguous / absent. */
  entry: string | null
  /** When entry is null and HTMLs exist, the list of candidates to pick from. */
  candidates: string[]
}

/**
 * Normalise a raw relative path:
 *   - Convert backslashes to forward slashes
 *   - Strip leading `./`
 *   - Trim whitespace
 */
function normalisePath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
}

/**
 * Return true if the path should be dropped (empty, `.`, or only separators).
 */
function isJunkPath(p: string): boolean {
  return p === '' || p === '.' || p === '/'
}

/**
 * Extract the top-level directory segment of a path.
 * 'mysite/index.html' → 'mysite'
 * 'index.html'        → '' (no directory)
 */
function topDir(p: string): string {
  const slash = p.indexOf('/')
  return slash === -1 ? '' : p.slice(0, slash)
}

/**
 * Given a list of file-path inputs, produce a SitePlan:
 *   - files: normalised (dir-stripped if applicable)
 *   - entry: resolved or null
 *   - candidates: all html files when entry is null
 */
export function planSiteUpload(inputs: { relPath: string }[]): SitePlan {
  // 1. Normalise and drop junk
  const normalised = inputs
    .map((f) => normalisePath(f.relPath))
    .filter((p) => !isJunkPath(p))

  if (normalised.length === 0) {
    return { files: [], entry: null, candidates: [] }
  }

  // 2. Folder-drop: strip single common top-level directory
  const tops = normalised.map(topDir)
  const firstTop = tops[0]
  const allShareOneDir =
    firstTop !== '' && tops.every((t) => t === firstTop)

  const stripped = allShareOneDir
    ? normalised.map((p) => p.slice(firstTop.length + 1)) // +1 for the '/'
    : normalised

  const files = stripped.map((relPath) => ({ relPath }))

  // 3. Entry detection
  const htmlFiles = stripped.filter(
    (p) => p.toLowerCase().endsWith('.html') || p.toLowerCase().endsWith('.htm'),
  )

  let entry: string | null
  let candidates: string[]

  if (htmlFiles.includes('index.html')) {
    entry = 'index.html'
    candidates = []
  } else if (htmlFiles.length === 1) {
    entry = htmlFiles[0]!
    candidates = []
  } else if (htmlFiles.length > 1) {
    entry = null
    candidates = htmlFiles
  } else {
    entry = null
    candidates = []
  }

  return { files, entry, candidates }
}
