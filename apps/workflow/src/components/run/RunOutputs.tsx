/**
 * What a run produced (08 §3): the workflow's own declared outputs, each
 * through the renderer the declaration resolves to. Top-level outputs *are*
 * persisted (the run row's `outputs`), so they are shown as recorded.
 *
 * Deliberately the run level only. A step's outputs are that step's own
 * row body (`StepBody`, Output) — listing every step's outputs here too made the
 * page show two levels of the taxonomy at once (2026-08-26 review), and job
 * outputs are derived, never persisted (05), so re-deriving them would mean
 * re-evaluating expressions and calling the result "what the run produced".
 */
import { outputImageMap } from '../../lib/imageMap'
import { RUN_SCOPE, resolveOutput } from '../../lib/outputDecls'
import type { Definition, RunState } from '../../lib/runner/types'
import { MediaSeekProvider } from '../values/MediaSeekContext'
import { ExpandAll } from '../values/ExpandAll'
import { ValuesOpenProvider, useValuesBulk } from '../values/valuesOpen'
import { ValueView } from '../values/ValueView'
import { withFileRefValue } from '../values/fileRef'
import { kindTag } from '../values/valueMeta'
import { isBulky } from '../values/valueSummary'

/** Declaration order first, then anything the run recorded but never declared. */
function outputNames(declared: string[], recorded: Record<string, unknown>): string[] {
  const extra = Object.keys(recorded).filter((name) => !declared.includes(name))
  return [...declared, ...extra]
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
  const { bulk, toggle } = useValuesBulk()

  return (
    <section className="outputs" data-testid="run-outputs">
      {topLevel.length === 0 ? (
        <p className="note">This workflow declares no outputs.</p>
      ) : (
        // Scoped to the run's own outputs, so a transcript here seeks a player
        // shown among these same outputs (Task 15).
        <MediaSeekProvider>
          <ExpandAll
            total={topLevel.length}
            foldable={
              topLevel.filter((name) =>
                isBulky(withFileRefValue(resolveOutput(def, RUN_SCOPE, name).decl, recorded[name]), recorded[name]),
              ).length
            }
            unit="output"
            open={bulk.open}
            onToggle={toggle}
          />
          <ValuesOpenProvider value={bulk}>
            <div className="output-group pane-values" data-scope="run">
              {topLevel.map((name) => {
                const resolved = resolveOutput(def, RUN_SCOPE, name)
                const decl = withFileRefValue(resolved.decl, recorded[name])
                return (
                  <div className="output" data-output={name} key={name}>
                    <ValueView
                      label={name}
                      tag={kindTag(decl)}
                      decl={decl}
                      value={recorded[name] ?? null}
                      impl={impl}
                      images={outputImageMap(def, state, decl, resolved.site)}
                      collapsible
                    />
                  </div>
                )
              })}
            </div>
          </ValuesOpenProvider>
        </MediaSeekProvider>
      )}
    </section>
  )
}
