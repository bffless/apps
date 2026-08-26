/**
 * The waiting form step's pane (03 `form` step, 08: "the pane is the form").
 *
 * Same renderer as the kickoff form (`FieldControl`) — including its uploads:
 * a mid-run `file` field uploads under the run's own implementation/workflow
 * with scope `inputs` (D18), the same scope the kickoff form uses, because a
 * mid-run answer is a human's input like any other and outlives the step that
 * asked for it. (`upload` is a prop only so a test can hand in a fake; the
 * default is the real `uploadFile`.)
 *
 * The fields are `formFieldDefs`', not the raw `with.fields`: a field's
 * `options` may be an expression over the run so far (03), and the form must
 * offer exactly the options its submit will then be checked against.
 *
 * Validation and the resulting event are entirely `completeFormStep`'s
 * (Task 10/lib/runner/adapters/form.ts) — this component's only two jobs are
 * to hold the in-progress field values and to route the pure result: `r.ok`
 * dispatches `runEvent(r.event)` for the middleware (Task 17) to persist and
 * schedule onward; otherwise the per-field errors it returned are shown. This
 * pane never persists anything itself.
 */
import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { completeFormStep, formFieldDefs, formInitialValues } from '../../lib/runner/adapters/form'
import type { Definition, FileRef, RunState, StepKey } from '../../lib/runner/types'
import { uploadFile } from '../../lib/upload'
import { useAppDispatch } from '../../store/hooks'
import { runEvent } from '../../store/runSlice'
import { StatusPill } from '../StatusPill'
import { FieldControl } from '../kickoff/FieldControl'
import { PaneCrumbs } from './PaneCrumbs'
import type { Crumb } from './PaneCrumbs'

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

export interface FormStepPaneProps {
  def: Definition
  state: RunState
  stepKey: StepKey
  /** Test seam: the default uploads through `lib/upload` under scope `inputs`. */
  upload?: (file: File, onProgress: (fraction: number) => void) => Promise<FileRef>
  /** The levels above (08: Run › job) — the form keeps waiting; its chip is the way back in. */
  trail?: Crumb[]
}

export function FormStepPane({ def, state, stepKey: key, upload, trail = [] }: FormStepPaneProps) {
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

  const impl = state.impl
  const workflow = state.workflow
  const uploading = useMemo(
    () =>
      upload ??
      ((file: File, onProgress: (fraction: number) => void) =>
        uploadFile({ impl, workflow, scope: 'inputs', file, onProgress })),
    [upload, impl, workflow],
  )

  if (!parts || !step || !stepState) {
    return (
      <aside className="step-pane" data-testid="step-pane" aria-label="Step">
        <h3 className="graph-panel-title">{key}</h3>
        <p className="note">This run has no record of that step.</p>
      </aside>
    )
  }

  const withDecl = obj(step.raw?.with)
  const fields = formFieldDefs({ step, def, state, job: parts.job, index: parts.index })
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
      <header className="pane-head">
        <span className="pane-title">
          <PaneCrumbs trail={trail} current={step.id} />
          <h3 className="graph-panel-title">{title}</h3>
          <span className="pane-key">{key}</span>
        </span>
        <StatusPill status={stepState.status} />
        <span className="pane-kind">form</span>
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
            upload={uploading}
            error={errors[name]}
          />
        ))}
        <button type="submit">{submitLabel}</button>
      </form>
    </aside>
  )
}
