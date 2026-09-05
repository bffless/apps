/**
 * The pure half of `workflow index`: lint an implementation's workflow YAMLs
 * and turn them into the `index.json` a bundle ships (06).
 *
 * `index.json` is the harness's only view of a bundle — it lists the workflows,
 * the islands and the scripts, and nothing else tells the harness what it may
 * run. So the build is deliberately strict: a workflow that fails lint fails
 * the whole index, because publishing it would hand the harness a workflow it
 * cannot run.
 *
 * Everything here is a function of its arguments — no `node:fs`, no clock, no
 * git. The writer (`./write.ts`) owns all three, which keeps this testable with
 * literal YAML and keeps the browser harness able to import it (09 purity
 * fence).
 */
import type { Finding } from '../findings.js'
import { loadDefinition } from '../lint.js'
import type { RuleSetContext } from '../rules/match.js'

/** One workflow to index: the name it ships under, and its source. */
export interface IndexWorkflowSource {
  file: string
  yaml: string
}

/** A workflow as `index.json` lists it — the shape the harness UI reads. */
export interface IndexWorkflowEntry {
  file: string
  name: string
  description: string
  inputs: number
  jobs: number
  /** 07: no interactive step would fail fast, so a headless run can complete it. */
  headlessSafe: boolean
}

/**
 * `index.json`, minus `generatedAt` — the one field a pure builder cannot
 * produce. `./write.ts` adds it on the way to disk.
 */
export interface IndexJson {
  spec: 1
  impl: string
  name: string
  description: string
  version: string
  commit: string
  workflows: IndexWorkflowEntry[]
  islands: string[]
  scripts: string[]
  /**
   * ADR-0006: the GitHub repo whose `workflow-drive.yml` a `repository_dispatch`
   * reaches; filled by the publish step from `github.repository`.
   */
  driver?: { repo: string }
}

/** A lint finding, tagged with the workflow it came from. */
export interface IndexFinding extends Finding {
  file: string
}

export interface BuildIndexArgs {
  /** The alias the bundle deploys to, e.g. `hello`. */
  impl: string
  /** Display name, shown on the Implementations screen. */
  name: string
  description?: string
  version: string
  commit: string
  workflows: IndexWorkflowSource[]
  /** Paths relative to the bundle root, e.g. `islands/pick-line.html`. */
  islands: string[]
  /** Paths relative to the bundle root, e.g. `scripts/analyze.js`. */
  scripts: string[]
  /** The implementation's own rule set, so every relative `with.path` is checked (06). */
  rules: RuleSetContext
  /** ADR-0006: the driver repo a `repository_dispatch` reaches; passed straight through to the index. */
  driver?: { repo: string }
}

export type BuildIndexResult =
  | { ok: true; index: IndexJson }
  | { ok: false; findings: IndexFinding[] }

export function buildIndex(args: BuildIndexArgs): BuildIndexResult {
  const failures: IndexFinding[] = []
  const entries: IndexWorkflowEntry[] = []

  for (const { file, yaml } of args.workflows) {
    // One pass, not two: loadDefinition is lintSource plus the typed document.
    const { def, findings } = loadDefinition(yaml, { file, rules: args.rules })
    // Notices are commentary (`outputs-omitted`, an unresolvable rule set);
    // errors and warnings are not, and either one fails the publish (06).
    // `def === null` only happens alongside a yaml-parse/schema error, but the
    // fallback keeps a workflow from being dropped in silence if that changes.
    if (def === null || findings.some((f) => f.severity === 'error' || f.severity === 'warning')) {
      // Keep going: a repo with two broken workflows deserves both in one run.
      const tagged = findings.map((f) => ({ ...f, file }))
      failures.push(
        ...(tagged.length > 0
          ? tagged
          : [{ file, rule: 'index', severity: 'error' as const, message: 'could not be loaded', path: '' }]),
      )
      continue
    }

    entries.push({
      file,
      name: def.name,
      description: def.raw.description ?? '',
      inputs: Object.keys(def.inputs).length,
      jobs: Object.keys(def.jobs).length,
      headlessSafe: !findings.some((f) => f.rule === 'interactive-headless'),
    })
  }

  if (failures.length > 0) return { ok: false, findings: failures }

  return {
    ok: true,
    index: {
      spec: 1,
      impl: args.impl,
      name: args.name,
      description: args.description ?? '',
      version: args.version,
      commit: args.commit,
      workflows: entries,
      islands: args.islands,
      scripts: args.scripts,
      ...(args.driver ? { driver: args.driver } : {}),
    },
  }
}
