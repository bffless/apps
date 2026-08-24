/**
 * One `on.manual.inputs` / `form` field (02, 08): shared by the kickoff form
 * and the (M2) mid-run form step — the vocabulary is the same closed set
 * either way.
 *
 * A `file` field uploads on select (prepare → PUT → register, 06) with a
 * progress bar and inline `accept`/`maxSize` errors (Decision 8); the field's
 * value only ever becomes the returned File ref (or a `FileRef[]` for
 * `list: true`), never a raw `File`. When no `upload` is given — the mid-run
 * form step before M2 wires it up — the control renders an unsupported
 * notice instead of a picker, so a workflow with file fields still opens.
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import type { FileRef } from '../../lib/runner/types'
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

interface Option { value: string; label: string }

/** `options: [a, {value,label}]` (02); anything not a string/object is dropped. */
function optionsOf(raw: unknown): Option[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): Option[] => {
    if (typeof entry === 'string') return [{ value: entry, label: entry }]
    if (entry !== null && typeof entry === 'object') {
      const o = entry as Record<string, unknown>
      const value = typeof o.value === 'string' ? o.value : undefined
      if (value === undefined) return []
      return [{ value, label: typeof o.label === 'string' ? o.label : value }]
    }
    return []
  })
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
  errorId,
  onError,
}: {
  def: InputDef
  value: unknown
  onChange: (v: unknown) => void
  upload?: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
  inputId: string
  errorId: string
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
        aria-describedby={errorId}
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

  let control: ReactNode
  switch (type) {
    case 'boolean':
      control = (
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
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
          aria-describedby={shownError ? errorId : undefined}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
      break

    case 'choice': {
      const options = optionsOf(def.options)
      if (list) {
        const selected = Array.isArray(value) ? value.map(String) : []
        control = (
          <div className="field-checkboxes">
            {options.map((opt) => (
              <label key={opt.value} className="field-checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
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
            aria-describedby={shownError ? errorId : undefined}
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
        <textarea
          id={id}
          className="field-markdown"
          value={typeof value === 'string' ? value : ''}
          aria-describedby={shownError ? errorId : undefined}
          onChange={(e) => onChange(e.target.value)}
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
          errorId={errorId}
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
            aria-describedby={shownError ? errorId : undefined}
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
            aria-describedby={shownError ? errorId : undefined}
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
