/**
 * The `choice` rendering for options that carry a **preview** (02): a grid of
 * tiles instead of a `<select>`/checkbox pair, single- or multi-select
 * depending on `list`.
 *
 * **Toggle buttons, not radios.** The obvious ARIA reading of "pick one of
 * these" is `role="radiogroup"` + `role="radio"`, and that is what this was —
 * but a radiogroup promises a keyboard pattern this never implemented (roving
 * `tabindex`, arrow keys to move the selection, one tab stop for the whole
 * group), so a screen-reader user was told about a widget that did not answer
 * to the keys it had just been promised. Plain `<button aria-pressed>` tiles
 * claim only what they do: every tile is its own tab stop, Space/Enter toggles
 * it, and the group is a plain `role="group"` named after the field. That is
 * the honest markup for the behaviour, and it needs no keyboard code of its
 * own. (Single-select still emits the tile's value on every click, so the
 * selection moves rather than clearing.)
 *
 * A preview only ever reaches an `<img src>` through `isSameOriginUrl`: an
 * option list is run-row JSON, and a cross-origin image is a beacon that
 * carries the member's session.
 */
import { isSameOriginUrl } from '../../lib/url'
import { FileCard } from '../values/FileCard'
import { isFileRef } from '../values/fileRef'
import type { Option, OptionPreview } from './options'

/**
 * A tile's picture: an image preview (same-origin only) as an `<img>`, any
 * other File ref as its own card, anything unreadable as nothing at all —
 * the label below it still names the option either way.
 */
export function TilePreview({ preview, label }: { preview: OptionPreview | undefined; label: string }) {
  if (typeof preview === 'string') {
    return isSameOriginUrl(preview) ? <img className="tile-image" src={preview} alt={label} /> : null
  }
  if (!isFileRef(preview)) return null
  const contentType = typeof preview.contentType === 'string' ? preview.contentType : ''
  if (contentType.startsWith('image/') && isSameOriginUrl(preview.url)) {
    return <img className="tile-image" src={preview.url} alt={preview.name || label} />
  }
  return <FileCard refValue={preview} />
}

export function TilePicker({
  options,
  value,
  list,
  onChange,
  label,
  invalid,
  describedBy,
}: {
  options: Option[]
  value: unknown
  list: boolean
  onChange: (v: unknown) => void
  label: string
  invalid: boolean
  describedBy: string | undefined
}) {
  const selected = list
    ? Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : []
    : typeof value === 'string'
      ? [value]
      : []

  return (
    <div
      className="tile-picker"
      data-testid="tile-picker"
      role="group"
      aria-label={label}
      aria-invalid={invalid}
      aria-describedby={describedBy}
    >
      {options.map((opt) => {
        const pressed = selected.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            className="tile"
            data-testid="tile"
            data-value={opt.value}
            aria-pressed={pressed}
            onClick={() =>
              onChange(
                list
                  ? pressed
                    ? selected.filter((v) => v !== opt.value)
                    : [...selected, opt.value]
                  : opt.value,
              )
            }
          >
            <TilePreview preview={opt.preview} label={opt.label} />
            <span className="tile-label">{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}
