/**
 * The waiting form step's pane (03 `form` step, 08: "the pane is the form").
 *
 * Same renderer as the kickoff form (`FieldControl`), but with no `upload`
 * wired in — Decision 1: file fields in a mid-run form are M2, so `FieldControl`
 * falls back to its own "not supported here yet" notice rather than this pane
 * inventing a picker.
 *
 * Validation and the resulting event are entirely `completeFormStep`'s
 * (Task 10/lib/runner/adapters/form.ts) — this component's only two jobs are
 * to hold the in-progress field values and to route the pure result: `r.ok`
 * dispatches `runEvent(r.event)` for the middleware (Task 17) to persist and
 * schedule onward; otherwise the per-field errors it returned are shown. This
 * pane never persists anything itself.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { InputDef } from '@bffless/workflow-lint/definition'
import { completeFormStep, formInitialValues } from '../../lib/runner/adapters/form'
import type { Definition, RunState, StepKey } from '../../lib/runner/types'
import { useAppDispatch } from '../../store/hooks'
import { runEvent } from '../../store/runSlice'
import { StatusPill } from '../StatusPill'
import { FieldControl } from '../kickoff/FieldControl'

/** `confirm/0/review` → its parts; a step id cannot contain `/`, so the split is exact. */
function parseKey(key: StepKey): { job: string; index: number; stepId: string } | null {
  const [job, index, ...rest] = key.split('/')
  if (job === undefined || index === undefined || rest.length === 0) return null
  const parsed = Number(index)
  return Number.isInteger(parsed) ? { job, index: parsed, stepId: rest.join('/') } : null
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** `with.fields` — the field definitions, which double as the output types (03). */
function fieldsOf(withDecl: unknown): Record<string, InputDef> {
  return obj(obj(withDecl).fields) as Record<string, InputDef>
}

export interface FormStepPaneProps {
  def: Definition
  state: RunState
  stepKey: StepKey
}

export function FormStepPane({ def, state, stepKey: key }: FormStepPaneProps) {
  const dispatch = useAppDispatch()
  const parts = parseKey(key)
  const step = parts ? def.jobs[parts.job]?.steps.find((candidate) => candidate.id === parts.stepId) : undefined
  const stepState = state.steps[key]

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    step && parts
      ? formInitialValues({ step, def, state, job: parts.job, index: parts.index })
      : {},
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!parts || !step || !stepState) {
    return (
      <aside className="step-pane" data-testid="step-pane" aria-label="Step">
        <h3 className="graph-panel-title">{key}</h3>
        <p className="note">This run has no record of that step.</p>
      </aside>
    )
  }

  const withDecl = obj(step.raw?.with)
  const fields = fieldsOf(withDecl)
  const fieldNames = Object.keys(fields)
  const title = typeof withDecl.title === 'string' && withDecl.title !== '' ? withDecl.title : step.id
  const description =
    typeof withDecl.description === 'string' && withDecl.description !== '' ? withDecl.description : undefined
  const submitLabel = typeof withDecl.submit === 'string' && withDecl.submit !== '' ? withDecl.submit : 'Submit'

  function setValue(name: string, v: unknown) {
    setValues((prev) => ({ ...prev, [name]: v }))
    setErrors((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const r = completeFormStep({
      step: step!,
      key,
      job: parts!.job,
      index: parts!.index,
      def,
      state,
      values,
      at: Date.now(),
    })
    if (r.ok) {
      setErrors({})
      dispatch(runEvent(r.event))
    } else {
      setErrors(r.errors)
    }
  }

  return (
    <aside className="step-pane form-step-pane" data-testid="step-pane" aria-label="Step">
      <header className="graph-panel-head">
        <h3 className="graph-panel-title">{title}</h3>
        <StatusPill status={stepState.status} />
      </header>

      {description && <p className="field-description">{description}</p>}

      <form className="form" data-testid="form-step" onSubmit={handleSubmit} noValidate>
        {fieldNames.length === 0 && <p className="note">This step declares no fields.</p>}
        {fieldNames.map((name) => (
          <FieldControl
            key={name}
            name={name}
            def={fields[name]!}
            value={values[name] ?? null}
            onChange={(v) => setValue(name, v)}
            error={errors[name]}
          />
        ))}
        <button type="submit">{submitLabel}</button>
      </form>
    </aside>
  )
}
