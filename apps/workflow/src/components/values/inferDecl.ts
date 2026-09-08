/**
 * What renderer a *recorded* value asks for when nothing declared one (02).
 *
 * Its own module rather than a private helper of one pane: `StepBody` reads it
 * for a step's evaluated `with` entries, and `JobIo` reads it for a matrix
 * item's own bindings — two screens showing values nothing declared a type
 * for, which must infer that type the same way or the same value would render
 * two different ways one click apart. A plain `.ts` file, so neither component
 * file has to export a non-component (react-refresh/only-export-components).
 *
 * A list of one scalar kind is that kind's list (chips, or the compact number
 * list); a list of File refs is a file list; any other array is `json`, whose
 * viewer reads the array's *shape* — homogeneous rows as a table, and so on
 * (02 "Inferred shapes", apps#450) — before falling back to the tree.
 */
import type { ValueDecl } from './ValueView'
import { isFileRef } from './fileRef'

export function inferDecl(value: unknown): ValueDecl {
  if (isFileRef(value)) return { type: 'file' }
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== null && item !== undefined)
    if (items.length > 0 && items.every(isFileRef)) return { type: 'file', list: true }
    if (items.length > 0 && items.every((item) => typeof item === 'string')) return { type: 'string', list: true }
    if (items.length > 0 && items.every((item) => typeof item === 'number')) return { type: 'number', list: true }
    if (items.length > 0 && items.every((item) => typeof item === 'boolean')) return { type: 'boolean', list: true }
    return { type: 'json' }
  }
  if (value !== null && typeof value === 'object') return { type: 'json' }
  if (typeof value === 'number') return { type: 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  return { type: 'string' }
}
