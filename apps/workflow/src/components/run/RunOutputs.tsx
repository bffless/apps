/**
 * What a run produced (08 §3): the workflow's own outputs first, then what each
 * job's steps recorded, job by job in scheduling order.
 *
 * The per-job half is deliberately the **steps'** outputs, not the job's: job
 * outputs are derived, never persisted (05 — a job is the fold of its step rows
 * plus the definition), so re-deriving them here would mean re-evaluating
 * expressions against a rebuilt state and calling the result "what the run
 * produced". The step rows are what the run actually wrote down, so they are
 * what this section shows.
 *
 * Top-level outputs *are* persisted (the run row's `outputs`), so those are
 * shown as recorded, each through the renderer the declaration resolves to.
 */
import { RUN_SCOPE, resolveOutputDecl, stepOutputDecl } from '../../lib/outputDecls'
import { jobOrder } from '../../lib/runner/graph'
import type { Definition, RunState, StepState } from '../../lib/runner/types'
import { MediaSeekProvider } from '../values/MediaSeekContext'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import { isFileRef } from '../values/fileRef'

/** A bare `${{ … }}` output can only be known to be a file by its value (02). */
function withValue(decl: ValueDecl, value: unknown): ValueDecl {
  return decl.type === 'json' && !decl.list && isFileRef(value) ? { type: 'file' } : decl
}

/** Declaration order first, then anything the run recorded but never declared. */
function outputNames(declared: string[], recorded: Record<string, unknown>): string[] {
  const extra = Object.keys(recorded).filter((name) => !declared.includes(name))
  return [...declared, ...extra]
}

/** The steps of one job that recorded outputs, in matrix-item then declaration order. */
function stepsOfJob(def: Definition, state: RunState, job: string): StepState[] {
  const order = def.jobs[job]?.steps.map((step) => step.id) ?? []
  return Object.values(state.steps)
    .filter((step) => step.job === job && Object.keys(step.outputs ?? {}).length > 0)
    .sort((a, b) => a.index - b.index || order.indexOf(a.stepId) - order.indexOf(b.stepId))
}

export function RunOutputs({ def, state }: { def: Definition; state: RunState }) {
  const recorded = state.outputs ?? {}
  const topLevel = outputNames(Object.keys(def.outputs ?? {}), recorded)

  return (
    <section className="outputs" data-testid="run-outputs">
      <h2 className="section-title">Outputs</h2>

      {topLevel.length === 0 ? (
        <p className="note">This workflow declares no outputs.</p>
      ) : (
        // Scoped to the run's own outputs, so a transcript here seeks a player
        // shown among these same outputs — never one in a different job's
        // block (Task 15).
        <MediaSeekProvider>
          <div className="output-group" data-scope="run">
            {topLevel.map((name) => (
              <div className="output" data-output={name} key={name}>
                <ValueView
                  label={name}
                  decl={withValue(resolveOutputDecl(def, RUN_SCOPE, name), recorded[name])}
                  value={recorded[name] ?? null}
                />
              </div>
            ))}
          </div>
        </MediaSeekProvider>
      )}

      {jobOrder(def).map((job) => {
        const steps = stepsOfJob(def, state, job)
        if (steps.length === 0) return null
        return (
          <MediaSeekProvider key={job}>
            <div className="output-group" data-scope="job" data-job={job}>
              <h3 className="section-title">{def.jobs[job]?.raw?.name ?? job}</h3>
              {steps.map((step) => {
                const declared = def.jobs[job]?.steps.find((s) => s.id === step.stepId)
                return Object.entries(step.outputs ?? {}).map(([name, value]) => (
                  <div className="output" data-output={`${step.key}.${name}`} key={`${step.key}.${name}`}>
                    <ValueView
                      label={`${step.key} · ${name}`}
                      decl={withValue(
                        declared ? stepOutputDecl(declared, name) : { type: 'json' },
                        value,
                      )}
                      value={value}
                    />
                  </div>
                ))
              })}
            </div>
          </MediaSeekProvider>
        )
      })}
    </section>
  )
}
