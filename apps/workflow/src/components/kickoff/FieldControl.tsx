/**
 * One `on.manual.inputs` / `form` field (02, 08): shared by the kickoff form
 * and the (M2) mid-run form step — the vocabulary is the same closed set
 * either way.
 *
 * A `file` field uploads on select (prepare → PUT → register, 06) with a
 * progress bar and inline `accept`/`maxSize` errors (Decision 8); the field's
 * value only ever becomes the returned File ref (or a `FileRef[]` for
 * `list: true`), never a raw `File`. When no `upload` is given — a caller
 * that has no scope to upload into — the control renders an unsupported
 * notice instead of a picker, so a workflow with file fields still opens.
 *
 * Two `choice` renderings (02): options that carry a **preview** (or that
 * *are* File refs, 02's shorthand) become a tile picker, everything else
 * stays the `<select>`/checkbox pair. Either way the value the field emits is
 * the option's plain value — a File-ref option's `path` — which is exactly
 * what `optionValue` (`lib/runner/inputConstraints`, shared with the submit-
 * time membership check) says it is worth. A preview only ever reaches an
 * `<img src>` through `isSameOriginUrl`: an option list is run-row JSON, and
 * a cross-origin image is a beacon that carries the member's session.
 *
 * A `markdown` field can toggle a rendered preview beside its (still
 * editable) textarea — the same `MarkdownView` the value side uses.
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { optionValue } from '../../lib/runner/inputConstraints'
import type { FileRef } from '../../lib/runner/types'
import { isSameOriginUrl } from '../../lib/url'
import { FileCard } from '../values/FileCard'
import { MarkdownView } from '../values/MarkdownView'
import { isFileRef } from '../values/fileRef'

export interface FieldControlProps {
  name: string
  def: InputDef
  value: unknown
  onChange: (v: unknown) => void
  upload?: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
  error?: string
}

/** `format` values (02) that map onto a native `<input type>`. */
const FORMAT_INPUT_TYPES: Record<string, string> = {
  url: 'url',
  email: 'email',
  date: 'date',
  datetime: 'datetime-local',
  password: 'password',
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

function humanSize(bytes: number): string {
  let n = bytes
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(1)} ${UNITS[i]}`
}

function fieldLabel(name: string, def: InputDef): string {
  return typeof def.label === 'string' && def.label !== '' ? def.label : name
}

interface Option { value: string; label: string; preview?: unknown }

/**
 * `options: [a, {value,label,preview?}, <File ref>]` (02); an entry whose
 * value cannot be read is dropped. A File-ref entry is the shorthand for
 * `{value: path, label: name, preview: ref}`, so it is its own preview.
 */
function optionsOf(raw: unknown): Option[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): Option[] => {
    const value = optionValue(entry)
    if (value === undefined) return []
    if (typeof entry !== 'object' || entry === null) return [{ value, label: value }]

    const o = entry as Record<string, unknown>
    const preview = o.preview !== undefined ? o.preview : isFileRef(entry) ? entry : undefined
    const label =
      typeof o.label === 'string' && o.label !== ''
        ? o.label
        : isFileRef(entry)
          ? entry.name
          : value
    return [{ value, label, ...(preview === undefined ? {} : { preview }) }]
  })
}

/**
 * A tile's picture: an image preview (same-origin only) as an `<img>`, any
 * other File ref as its own card, anything unreadable as nothing at all —
 * the label below it still names the option either way.
 */
function TilePreview({ preview, label }: { preview: unknown; label: string }) {
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

/** The `choice` rendering for options with previews (02): radio tiles, or checkbox tiles for a list. */
function TilePicker({
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
      role={list ? 'group' : 'radiogroup'}
      aria-label={label}
      aria-invalid={invalid}
      aria-describedby={describedBy}
    >
      {options.map((opt) => {
        const checked = selected.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            className="tile"
            data-testid="tile"
            data-value={opt.value}
            role={list ? 'checkbox' : 'radio'}
            aria-checked={checked}
            onClick={() =>
              onChange(
                list
                  ? checked
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

/** The `markdown` rendering (02): a textarea with a toggleable rendered preview beside it. */
function MarkdownControl({
  inputId,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  inputId: string
  value: unknown
  onChange: (v: unknown) => void
  invalid: boolean
  describedBy: string | undefined
}) {
  const [previewing, setPreviewing] = useState(false)
  const text = typeof value === 'string' ? value : ''

  return (
    <div className="field-markdown-editor">
      <button
        type="button"
        className="field-markdown-toggle"
        aria-pressed={previewing}
        onClick={() => setPreviewing((on) => !on)}
      >
        Preview
      </button>
      <div className="field-markdown-panes">
        <textarea
          id={inputId}
          className="field-markdown"
          value={text}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
        {previewing && (
          <div className="markdown-preview" data-testid="markdown-preview">
            <MarkdownView value={text} />
          </div>
        )}
      </div>
    </div>
  )
}

/** `accept` (02): a comma-separated list of MIME types, `type/*`, or `.ext`. */
function matchesAccept(file: File, accept: string): boolean {
  return accept
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((pattern) => {
      if (pattern.startsWith('.')) return file.name.toLowerCase().endsWith(pattern.toLowerCase())
      if (pattern.endsWith('/*')) return file.type.startsWith(pattern.slice(0, -1))
      return file.type === pattern
    })
}

function FileControl({
  def,
  value,
  onChange,
  upload,
  inputId,
  invalid,
  describedBy,
  onError,
}: {
  def: InputDef
  value: unknown
  onChange: (v: unknown) => void
  upload?: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
  inputId: string
  invalid: boolean
  describedBy: string | undefined
  onError: (message: string | undefined) => void
}) {
  const [progress, setProgress] = useState<number | null>(null)
  const list = def.list === true
  const accept = typeof def.accept === 'string' ? def.accept : undefined
  const maxSize = typeof def.maxSize === 'number' ? def.maxSize : undefined

  const refs: FileRef[] = list
    ? Array.isArray(value)
      ? value.filter(isFileRef)
      : []
    : isFileRef(value)
      ? [value]
      : []

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0 || !upload) return
    const picked = Array.from(files)

    for (const file of picked) {
      if (accept && !matchesAccept(file, accept)) {
        onError(`"${file.name}" is not a ${accept} file`)
        return
      }
      if (maxSize !== undefined && file.size > maxSize) {
        onError(`"${file.name}" is larger than ${humanSize(maxSize)}`)
        return
      }
    }

    onError(undefined)
    setProgress(0)
    try {
      const uploaded = await Promise.all(picked.map((file) => upload(file, setProgress)))
      onChange(list ? [...refs, ...uploaded] : (uploaded[0] ?? null))
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setProgress(null)
    }
  }

  if (!upload) {
    return <p className="note">File uploads are not supported here yet.</p>
  }

  return (
    <div className="field-file">
      <input
        id={inputId}
        type="file"
        accept={accept}
        multiple={list}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(e) => {
          void handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
      {progress !== null && (
        <progress className="field-progress" value={progress} max={1} aria-label={`Uploading ${def.label ?? ''}`} />
      )}
      {refs.length > 0 && (
        <ul className="field-file-list">
          {refs.map((ref) => (
            <li key={ref.path}>{ref.name}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function FieldControl({ name, def, value, onChange, upload, error }: FieldControlProps) {
  const id = useId()
  const errorId = `${id}-error`
  const [localError, setLocalError] = useState<string | undefined>()
  const type = typeof def.type === 'string' ? def.type : 'string'
  const list = def.list === true
  const shownError = error ?? localError
  const invalid = shownError ? true : false
  const describedBy = shownError ? errorId : undefined

  let control: ReactNode
  switch (type) {
    case 'boolean':
      control = (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.checked)}
        />
      )
      break

    case 'number':
      control = (
        <input
          id={id}
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={typeof def.min === 'number' ? def.min : undefined}
          max={typeof def.max === 'number' ? def.max : undefined}
          step={typeof def.step === 'number' ? def.step : undefined}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
      break

    case 'choice': {
      const options = optionsOf(def.options)
      if (options.some((opt) => opt.preview !== undefined)) {
        control = (
          <TilePicker
            options={options}
            value={value}
            list={list}
            onChange={onChange}
            label={fieldLabel(name, def)}
            invalid={invalid}
            describedBy={describedBy}
          />
        )
      } else if (list) {
        const selected = Array.isArray(value) ? value.map(String) : []
        control = (
          <div className="field-checkboxes">
            {options.map((opt) => (
              <label key={opt.value} className="field-checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...selected, opt.value]
                        : selected.filter((v) => v !== opt.value),
                    )
                  }
                />
                {opt.label}
              </label>
            ))}
          </div>
        )
      } else {
        control = (
          <select
            id={id}
            value={typeof value === 'string' ? value : ''}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="" disabled>
              Choose…
            </option>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )
      }
      break
    }

    case 'markdown':
      control = (
        <MarkdownControl
          inputId={id}
          value={value}
          onChange={onChange}
          invalid={invalid}
          describedBy={describedBy}
        />
      )
      break

    case 'file':
      control = (
        <FileControl
          def={def}
          value={value}
          onChange={onChange}
          upload={upload}
          inputId={id}
          invalid={invalid}
          describedBy={describedBy}
          onError={setLocalError}
        />
      )
      break

    default:
      control =
        def.format === 'textarea' ? (
          <textarea
            id={id}
            value={typeof value === 'string' ? value : ''}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            id={id}
            type={FORMAT_INPUT_TYPES[typeof def.format === 'string' ? def.format : ''] ?? 'text'}
            value={typeof value === 'string' ? value : ''}
            pattern={typeof def.pattern === 'string' ? def.pattern : undefined}
            minLength={typeof def.minLength === 'number' ? def.minLength : undefined}
            maxLength={typeof def.maxLength === 'number' ? def.maxLength : undefined}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value)}
          />
        )
  }

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {fieldLabel(name, def)}
        {def.required === true && (
          <span className="field-required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {typeof def.description === 'string' && def.description !== '' && (
        <p className="field-description">{def.description}</p>
      )}
      {control}
      {shownError && (
        <p className="field-error" id={errorId}>
          {shownError}
        </p>
      )}
    </div>
  )
}
