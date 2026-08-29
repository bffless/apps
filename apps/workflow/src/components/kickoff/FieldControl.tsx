/**
 * One `on.manual.inputs` / `form` field (02, 08): shared by the kickoff form
 * and the (M2) mid-run form step — the vocabulary is the same closed set
 * either way. This module is the *dispatch*: which control a field's `type`
 * and `format` get, the label/description/error frame around it, and nothing
 * else. The three controls with real behaviour of their own live beside it —
 * `./TilePicker` (a `choice` whose options carry previews), `./FileControl`
 * (upload on select, 06) and `./options` (what an `options` entry is worth).
 *
 * Two `choice` renderings (02): options that carry a **preview** (or that
 * *are* File refs, 02's shorthand) become a tile picker, everything else
 * stays the `<select>`/checkbox pair. Either way the value the field emits is
 * the option's plain value — a File-ref option's `path` — which is exactly
 * what `optionValue` (`lib/runner/inputConstraints`, shared with the submit-
 * time membership check) says it is worth.
 *
 * A `markdown` field can toggle a rendered preview beside its (still
 * editable) textarea — the same `MarkdownView` the value side uses.
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import type { FileRef } from '../../lib/runner/types'
import { MarkdownView } from '../values/MarkdownView'
import { FileControl } from './FileControl'
import { TilePicker } from './TilePicker'
import { hasPreviews, optionsOf } from './options'

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

function fieldLabel(name: string, def: InputDef): string {
  return typeof def.label === 'string' && def.label !== '' ? def.label : name
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

export function FieldControl({ name, def, value, onChange, upload, error }: FieldControlProps) {
  const id = useId()
  const errorId = `${id}-error`
  const [localError, setLocalError] = useState<string | undefined>()
  const type = typeof def.type === 'string' ? def.type : 'string'
  const list = def.list === true
  const label = fieldLabel(name, def)
  const shownError = error ?? localError
  const invalid = shownError ? true : false
  const describedBy = shownError ? errorId : undefined

  // Whether the field's caption can be a `<label htmlFor>`: it can only point
  // at a single labelable element, and the two *grouped* `choice` renderings
  // (tiles, checkboxes) are a set of controls inside a plain `<div>` — a
  // `htmlFor` at one of those names nothing at all. Those name themselves with
  // `aria-label` on the group instead, and the caption is plain text.
  let grouped = false
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
      if (hasPreviews(options)) {
        grouped = true
        control = (
          <TilePicker
            options={options}
            value={value}
            list={list}
            onChange={onChange}
            label={label}
            invalid={invalid}
            describedBy={describedBy}
          />
        )
      } else if (list) {
        grouped = true
        const selected = Array.isArray(value) ? value.map(String) : []
        control = (
          <div
            className="field-checkboxes"
            role="group"
            aria-label={label}
            aria-invalid={invalid}
            aria-describedby={describedBy}
          >
            {options.map((opt) => (
              <label key={opt.value} className="field-checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  aria-invalid={invalid}
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

  const caption = (
    <>
      {label}
      {def.required === true && (
        <span className="field-required" aria-hidden="true">
          {' '}
          *
        </span>
      )}
    </>
  )

  return (
    <div className="field">
      {grouped ? (
        <span className="field-label">{caption}</span>
      ) : (
        <label className="field-label" htmlFor={id}>
          {caption}
        </label>
      )}
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
