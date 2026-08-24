/**
 * The kickoff form (08): one `FieldControl` per `on.manual.inputs` entry.
 * Start stays disabled while a required field is unanswered or an upload is
 * still in flight — "the form is valid only when uploads are registered".
 *
 * Re-run prefill (`initial`) reuses a previous run's File refs untouched: a
 * value already present in `initial` is never re-derived from `def.default`.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { validateInputConstraints } from '../../lib/runner/inputConstraints'
import { validateValue } from '../../lib/runner/outputs'
import type { FileRef } from '../../lib/runner/types'
import { FieldControl } from './FieldControl'

export interface KickoffFormProps {
  inputs: Record<string, InputDef>
  /** Re-run prefill (08): a previous run's `inputs`. */
  initial?: Record<string, unknown>
  uploading: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
  onStart: (values: Record<string, unknown>) => void
}

/** "Unanswered" for `required` — `false` and `0` are answers (03's own rule). */
function blank(value: unknown, list: boolean): boolean {
  if (value === null || value === undefined || value === '') return true
  return list && Array.isArray(value) && value.length === 0
}

function initialValues(
  inputs: Record<string, InputDef>,
  initial: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(inputs)) {
    if (initial && name in initial) values[name] = initial[name]
    else values[name] = def.default === undefined ? null : def.default
  }
  return values
}

function typeOf(def: InputDef): string {
  return typeof def.type === 'string' ? def.type : 'string'
}

export function KickoffForm({ inputs, initial, uploading, onStart }: KickoffFormProps) {
  const names = Object.keys(inputs)
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(inputs, initial))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [uploadsInFlight, setUploadsInFlight] = useState(0)

  function setValue(name: string, v: unknown) {
    setValues((prev) => ({ ...prev, [name]: v }))
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  function upload(file: File, onProgress: (fraction: number) => void): Promise<FileRef> {
    setUploadsInFlight((n) => n + 1)
    return uploading(file, onProgress).finally(() => setUploadsInFlight((n) => n - 1))
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()

    const nextErrors: Record<string, string> = {}
    for (const [name, def] of Object.entries(inputs)) {
      const type = typeOf(def)
      const list = def.list === true
      const value = values[name] ?? null
      if (def.required === true && blank(value, list)) {
        nextErrors[name] = 'This field is required'
        continue
      }
      if (!validateValue(type, list, value)) {
        nextErrors[name] = `Expected a valid ${type} value`
        continue
      }
      const constraintError = validateInputConstraints(def, value)
      if (constraintError) nextErrors[name] = constraintError
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }
    onStart(values)
  }

  const missingRequired = names.some((name) => {
    const def = inputs[name]
    return def.required === true && blank(values[name] ?? null, def.list === true)
  })
  const disabled = uploadsInFlight > 0 || missingRequired

  return (
    <form className="form" data-testid="kickoff-form" onSubmit={handleSubmit} noValidate>
      {names.length === 0 && <p className="note">This workflow takes no inputs.</p>}
      {names.map((name) => (
        <FieldControl
          key={name}
          name={name}
          def={inputs[name]!}
          value={values[name] ?? null}
          onChange={(v) => setValue(name, v)}
          upload={upload}
          error={errors[name]}
        />
      ))}
      <button type="submit" data-testid="kickoff-start" disabled={disabled}>
        Start
      </button>
    </form>
  )
}
