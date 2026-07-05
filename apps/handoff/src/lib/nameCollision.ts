/**
 * In-Folder name-uniqueness decision (structural storage, Slice 4 / issue #159).
 *
 * Once a name identifies content within a Folder (verbatim structural storage,
 * Slice 1), adding a File or Site whose name equals an existing sibling in the
 * same Folder must be rejected — never silently overwritten and never
 * auto-suffixed. Auto-suffixing would rename the added item, breaking the
 * relative references (`assets/logo.png`) that the verbatim design exists to
 * preserve. So the only safe answer to a collision is a clear, up-front error.
 *
 * This is the single pure decision seam. It is consumed twice:
 *   - client pre-flight (FolderView) — instant, clear feedback before any bytes
 *     are uploaded, so the existing file's stored object is never overwritten;
 *   - the `/api/*` pipelines + MSW mocks mirror the same rule server-side, which
 *     is the authoritative gate for direct API / MCP callers.
 *
 * Names are compared byte-for-byte (case- and unicode-sensitive), matching the
 * verbatim storage key: `a.md` and `A.md` are distinct keys, so distinct
 * siblings — never a collision.
 */

/** The minimum a sibling node needs for the collision decision. */
export interface SiblingRef {
  name: string
  parentId: string
}

/**
 * True when `candidateName` already names a sibling directly under `parentId`.
 *
 * Scoped by `parentId`, so the same name in a different Folder is not a
 * collision. Any sibling type counts (a File named `docs` collides with a
 * Folder named `docs`) because a name identifies content regardless of kind.
 */
export function isNameTaken(
  siblings: readonly SiblingRef[],
  parentId: string,
  candidateName: string,
): boolean {
  return siblings.some((s) => s.parentId === parentId && s.name === candidateName)
}

/** Clear, user-facing message for a rejected duplicate name. */
export function nameCollisionMessage(name: string): string {
  return `“${name}” already exists in this folder. Rename it and try again.`
}
