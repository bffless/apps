/**
 * One `choice` field's `options` (02) → what the field renderers show.
 *
 * `options: [a, {value,label,preview?}, <File ref>]`; an entry whose value
 * cannot be read is dropped. A File-ref entry is 02's shorthand for
 * `{value: path, label: name, preview: ref}`, so it is its own preview. The
 * value an option is worth is `optionValue`'s (`lib/runner/inputConstraints`,
 * shared with the submit-time membership check) — a tile the user can click
 * can never be a value the submit then refuses.
 */
import { optionValue } from '../../lib/runner/inputConstraints'
import type { FileRef } from '../../lib/runner/types'
import { isFileRef } from '../values/fileRef'

/**
 * A preview is what a tile can actually *show*: a url string or a File ref.
 * Anything else — `preview: null`, a number, a bag of metadata — is not a
 * preview, and must not be treated as one: the presence of any preview is what
 * flips the whole field from a `<select>` into a tile picker, so a stray
 * `preview: null` used to turn a plain dropdown into a grid of blank tiles.
 */
export type OptionPreview = string | FileRef

export interface Option {
  value: string
  label: string
  preview?: OptionPreview
}

function previewOf(preview: unknown): OptionPreview | undefined {
  if (typeof preview === 'string') return preview === '' ? undefined : preview
  return isFileRef(preview) ? preview : undefined
}

export function optionsOf(raw: unknown): Option[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): Option[] => {
    const value = optionValue(entry)
    if (value === undefined) return []
    if (typeof entry !== 'object' || entry === null) return [{ value, label: value }]

    const o = entry as Record<string, unknown>
    const preview = previewOf(o.preview) ?? (isFileRef(entry) ? entry : undefined)
    const label =
      typeof o.label === 'string' && o.label !== ''
        ? o.label
        : isFileRef(entry)
          ? entry.name
          : value
    return [{ value, label, ...(preview === undefined ? {} : { preview }) }]
  })
}

/** Does this options list want the tile rendering (02) rather than the `<select>`/checkbox pair? */
export function hasPreviews(options: Option[]): boolean {
  return options.some((opt) => opt.preview !== undefined)
}
