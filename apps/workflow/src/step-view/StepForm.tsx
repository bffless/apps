/**
 * A waiting form step inside an agent host (Phase 4, Decisions 4–6): the
 * harness's own field controls over the fields the endpoint answered — the
 * ones the page evaluated when the step started waiting — submitted through
 * the bridge. No validation of its own: Submit is disabled while a required
 * field is blank (the kickoff form's rule), the endpoint's `validateFormOutputs`
 * is the authority, and its per-field refusals land under the fields. Files
 * cannot be attached from a sandboxed origin, so the file control's upload
 * refuses with a message that says where to attach one.
 *
 * Submit is a button click, never a native form submission: a sandboxed host
 * frame without `allow-forms` (claude.ai's is `allow-scripts allow-same-origin`)
 * returns from the submission algorithm before the `submit` event fires, so a
 * `<form onSubmit>` would silently do nothing there.
 */
import { useState } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { FieldControl } from '../components/kickoff/FieldControl'
import type { SubmitAnswer } from '../islands/IslandHost'
import { blank } from '../lib/autoStart'
import type { FileRef } from '../lib/runner/types'

export const NO_UPLOADS = 'Files cannot be attached from inside an agent host — attach this one on the harness page'

export interface StepFormProps {
  title: string
  description?: string
  submitLabel: string
  fields: Record<string, InputDef>
  initial: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => Promise<SubmitAnswer>
}

const refuseUpload = (): Promise<FileRef> => Promise.reject(new Error(NO_UPLOADS))

export function StepForm({ title, description, submitLabel, fields, initial, onSubmit }: StepFormProps) {
  const names = Object.keys(fields)
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initial }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  function setValue(name: string, v: unknown) {
    setValues((prev) => ({ ...prev, [name]: v }))
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  const missingRequired = names.some((name) => {
    const def = fields[name]!
    return def.required === true && blank(values[name] ?? null, def.list === true)
  })

  async function submit(): Promise<void> {
    if (pending || done || missingRequired) return
    setPending(true)
    try {
      const answer = await onSubmit(values)
      if (answer.ok) {
        setErrors({})
        setDone(true)
      } else {
        setErrors(answer.errors)
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="form step-form"
      data-testid="form-step"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
          e.preventDefault()
          void submit()
        }
      }}
      noValidate
    >
      <h2 className="graph-panel-title">{title}</h2>
      {description && <p className="field-description">{description}</p>}
      {names.length === 0 && <p className="note">This step declares no fields.</p>}
      {names.map((name) => (
        <FieldControl key={name} name={name} def={fields[name]!} value={values[name] ?? null} onChange={(v) => setValue(name, v)} upload={refuseUpload} error={errors[name]} />
      ))}
      {errors.values && (
        <p className="field-error" role="alert" data-testid="form-step-error">
          {errors.values}
        </p>
      )}
      <button type="button" data-testid="form-step-submit" disabled={pending || done || missingRequired} onClick={() => void submit()}>
        {submitLabel}
      </button>
    </form>
  )
}
