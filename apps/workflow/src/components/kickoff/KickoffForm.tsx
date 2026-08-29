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
import { blank, initialValues, validateInputs } from '../../lib/autoStart'
import type { FileRef } from '../../lib/runner/types'
import { FieldControl } from './FieldControl'

export interface KickoffFormProps {
  inputs: Record<string, InputDef>
  /** Re-run prefill (08): a previous run's `inputs`. */
  initial?: Record<string, unknown>
  uploading: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
  onStart: (values: Record<string, unknown>) => void
  /**
   * "Don't wait for me" (07): offered when the workflow has a step that would
   * otherwise wait on the person, controlled by the page (it is a run-level
   * fact, not an input, so it never lands in `values`). Absent = not offered.
   */
  unattended?: { value: boolean; onChange: (value: boolean) => void }
}

export function KickoffForm({ inputs, initial, uploading, onStart, unattended }: KickoffFormProps) {
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

    // The same loop `?auto=1` runs (`lib/autoStart`) — deliberately one
    // function, so a driver's inputs and a person's can never be judged
    // differently.
    const nextErrors = validateInputs(inputs, values)
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
      {unattended && (
        <div className="field kickoff-unattended">
          <label className="field-checkbox">
            <input
              type="checkbox"
              data-testid="kickoff-unattended"
              checked={unattended.value}
              onChange={(e) => unattended.onChange(e.target.checked)}
            />
            <span className="field-label">Don&apos;t wait for me</span>
          </label>
          <p className="field-description">
            Apply each step&apos;s <code>headless:</code> declaration as a headless run would:
            islands that declare <code>auto</code> submit by themselves, forms that declare{' '}
            <code>skip</code> use their declared outputs. Steps that declare neither still wait
            for you.
          </p>
        </div>
      )}
      <button type="submit" data-testid="kickoff-start" disabled={disabled}>
        Start
      </button>
    </form>
  )
}
