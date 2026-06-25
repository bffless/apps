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

export interface SitePlan<T extends { relPath: string } = { relPath: string }> {
  /**
   * Normalised file list (same order, post-normalisation). Each item is the
   * original input object with its `relPath` replaced by the normalised path.
   */
  files: T[]
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
 * Given a list of inputs (each with at least a `relPath`), produce a SitePlan:
 *   - files: original items with `relPath` replaced by the normalised path,
 *            junk entries dropped — no string re-pairing needed at the call site
 *   - entry: resolved or null
 *   - candidates: all html files when entry is null
 *
 * The generic `T extends { relPath: string }` means callers can pass richer
 * objects (e.g. `{ relPath, file }`) and receive them back with normalised paths.
 */
export function planSiteUpload<T extends { relPath: string }>(inputs: T[]): SitePlan<T> {
  // 1. Normalise and drop junk — keep the original item associated with its path
  const normalised: Array<{ item: T; path: string }> = inputs
    .map((item) => ({ item, path: normalisePath(item.relPath) }))
    .filter(({ path }) => !isJunkPath(path))

  if (normalised.length === 0) {
    return { files: [], entry: null, candidates: [] }
  }

  // 2. Folder-drop: strip single common top-level directory
  const tops = normalised.map(({ path }) => topDir(path))
  const firstTop = tops[0]
  const allShareOneDir =
    firstTop !== '' && tops.every((t) => t === firstTop)

  const stripped = normalised.map(({ item, path }) => ({
    item,
    path: allShareOneDir ? path.slice(firstTop!.length + 1) : path,
  }))

  // Return each original item with its relPath replaced by the normalised value
  const files = stripped.map(({ item, path }) => ({ ...item, relPath: path }))

  // 3. Entry detection
  const htmlPaths = stripped
    .map(({ path }) => path)
    .filter((p) => p.toLowerCase().endsWith('.html') || p.toLowerCase().endsWith('.htm'))

  let entry: string | null
  let candidates: string[]

  if (htmlPaths.includes('index.html')) {
    entry = 'index.html'
    candidates = []
  } else if (htmlPaths.length === 1) {
    entry = htmlPaths[0]!
    candidates = []
  } else if (htmlPaths.length > 1) {
    entry = null
    candidates = htmlPaths
  } else {
    entry = null
    candidates = []
  }

  return { files, entry, candidates }
}
