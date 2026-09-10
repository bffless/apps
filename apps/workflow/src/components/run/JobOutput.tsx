/**
 * "Job output" — the job's own declared `outputs:`, as a section **below the
 * step rows** (2026-09-09 UX review).
 *
 * It used to be the Output side of the `JobIo` disclosure above the steps,
 * which put the job's result before the work that produced it: *"I feel like
 * the job output should be down below here, underneath the steps. It's what
 * happens at the end, so it should be at the bottom."* Reading the page top to
 * bottom now follows the run: what the job was given, what it did, what came
 * out. The Input/Output toggle goes with the split — two sections in the
 * places their contents belong need no switch between them.
 *
 * The values themselves are the old pane's, unchanged in substance: aliases
 * over the steps' outputs, collected into lists for a matrix job, evaluated
 * the way every downstream `needs.<job>.outputs.<name>` reads them
 * (`buildRunContexts`). Job outputs are derived, never persisted (05), so this
 * is the one place a person can see them as values. On one item, each
 * collected list shows *that item's element* of it, so the leg's own line is
 * not buried in the whole job's list.
 */
import { outputImageMap } from '../../lib/imageMap'
import { resolveOutput } from '../../lib/outputDecls'
import { buildRunContexts } from '../../lib/runner/contexts'
import { dataFlowEdges } from '../../lib/runner/graph'
import type { Definition, RunState } from '../../lib/runner/types'
import { ExpandAll } from '../values/ExpandAll'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import { ValuesOpenProvider, useValuesBulk } from '../values/valuesOpen'
import { withFileRefValue } from '../values/fileRef'
import { kindTag } from '../values/valueMeta'
import { isBulky } from '../values/valueSummary'

/** One element of a collected list is that list's type without the list. */
function elementDecl(decl: ValueDecl): ValueDecl {
  const next = { ...decl }
  delete next.list
  return next
}

/** "goes to `<job>/<step>`, …" — every step whose expressions read this job output. */
function destinationOf(def: Definition, job: string, output: string): string | undefined {
  const targets = dataFlowEdges(def)
    .filter((edge) => edge.from.job === job && edge.from.step === undefined && edge.from.output === output)
    .map((edge) => `${edge.to.job}/${edge.to.step}`)
  const unique = [...new Set(targets)]
  return unique.length > 0 ? unique.join(', ') : undefined
}

export interface JobOutputProps {
  def: Definition
  state: RunState
  job: string
  /** One item of a matrix job: its element of each collected output. */
  index?: number
  /** Overrides `ImplContext` — only `render: island` outputs read it (`ValueView`). */
  impl?: string
  /** Arrived at by an out-dot (`?tab=Output`): open the rows it was clicked for. */
  initialOpen?: boolean
}

export function JobOutput({ def, state, job, index, impl, initialOpen = false }: JobOutputProps) {
  const decl = def.jobs[job]
  // Evaluated the way `jobs.<job>.outputs` / `needs.<job>.outputs` read them.
  const runCtx = buildRunContexts(def, state) as {
    jobs?: Record<string, { outputs: Record<string, unknown> | null }>
  }
  const outputs = runCtx.jobs?.[job]?.outputs ?? null
  const outputNames = Object.keys(decl?.outputs ?? {})
  const { bulk, toggle } = useValuesBulk(initialOpen)

  // Resolved up front so the bar can count what actually folds, not how many
  // outputs there are — see `ExpandAll`.
  const rows = outputNames.map((name) => {
    const collected = outputs?.[name] ?? null
    // One item shows its own element of the collected list (spec §The job page).
    const value =
      index === undefined
        ? collected
        : Array.isArray(collected)
          ? ((collected as unknown[])[index] ?? null)
          : collected
    const resolved = resolveOutput(def, { kind: 'job', job }, name)
    const base = index === undefined ? resolved.decl : elementDecl(resolved.decl)
    return { name, value, resolved, decl: withFileRefValue(base, value) }
  })

  return (
    <section className="job-output" data-testid="job-output">
      <h2 className="section-title">Job output</h2>
      {rows.length === 0 ? (
        <p className="note">
          This job declares no outputs of its own — its steps' outputs are on each step.
        </p>
      ) : (
        <>
          <ExpandAll
            count={rows.filter((row) => isBulky(row.decl, row.value)).length}
            unit="output"
            open={bulk.open}
            onToggle={toggle}
          />
          <ValuesOpenProvider value={bulk}>
            <div className="pane-values">
              {rows.map(({ name, value, resolved, decl: d }) => {
                return (
                  <ValueView
                    key={name}
                    label={name}
                    tag={kindTag(d)}
                    decl={d}
                    value={value}
                    impl={impl}
                    images={outputImageMap(def, state, d, resolved.site)}
                    destination={destinationOf(def, job, name)}
                    collapsible
                  />
                )
              })}
            </div>
          </ValuesOpenProvider>
        </>
      )}
    </section>
  )
}
