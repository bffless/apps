/**
 * What a run produced (08 §3): the workflow's own declared outputs, each
 * through the renderer the declaration resolves to. Top-level outputs *are*
 * persisted (the run row's `outputs`), so they are shown as recorded.
 *
 * Deliberately the run level only. A step's outputs are that step's own
 * pane (`StepPane`, Output) — listing every step's outputs here too made the
 * page show two levels of the taxonomy at once (2026-08-26 review), and job
 * outputs are derived, never persisted (05), so re-deriving them would mean
 * re-evaluating expressions and calling the result "what the run produced".
 */
import { RUN_SCOPE, resolveOutputDecl } from '../../lib/outputDecls'
import type { Definition, RunState } from '../../lib/runner/types'
import { MediaSeekProvider } from '../values/MediaSeekContext'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import { withFileRefValue } from '../values/fileRef'

/** Declaration order first, then anything the run recorded but never declared. */
function outputNames(declared: string[], recorded: Record<string, unknown>): string[] {
  const extra = Object.keys(recorded).filter((name) => !declared.includes(name))
  return [...declared, ...extra]
}

/** The mono tag beside a value's name: its declared type, and its renderer when named. */
function kindTag(decl: ValueDecl): string {
  const base = `${decl.type}${decl.list ? ' · list' : ''}`
  return typeof decl.render === 'string' ? `${base} · ${decl.render}` : base
}

export function RunOutputs({
  def,
  state,
  impl,
}: {
  def: Definition
  state: RunState
  /** Overrides `ImplContext` — only `render: island` outputs read it (`ValueView`). */
  impl?: string
}) {
  const recorded = state.outputs ?? {}
  const topLevel = outputNames(Object.keys(def.outputs ?? {}), recorded)

  return (
    <section className="outputs" data-testid="run-outputs">
      {topLevel.length === 0 ? (
        <p className="note">This workflow declares no outputs.</p>
      ) : (
        // Scoped to the run's own outputs, so a transcript here seeks a player
        // shown among these same outputs (Task 15).
        <MediaSeekProvider>
          <div className="output-group pane-values" data-scope="run">
            {topLevel.map((name) => {
              const decl = withFileRefValue(resolveOutputDecl(def, RUN_SCOPE, name), recorded[name])
              return (
                <div className="output" data-output={name} key={name}>
                  <ValueView
                    label={name}
                    tag={kindTag(decl)}
                    decl={decl}
                    value={recorded[name] ?? null}
                    impl={impl}
                  />
                </div>
              )
            })}
          </div>
        </MediaSeekProvider>
      )}
    </section>
  )
}
