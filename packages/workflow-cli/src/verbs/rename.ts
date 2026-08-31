/**
 * `workflow rename <old> <new>` — the CLI wrapper around the boundary-aware
 * rename engine (../rewrite.ts, plan Decision 6:
 * docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:22). It adds
 * exactly two things on top of `renamePass`: identity is read from disk, not
 * trusted from the argument — `<old>` has to match what `.bffless/
 * workflow.json` (../identity.ts) actually says, or the caller named the
 * wrong tree and the command refuses rather than guessing which alias they
 * meant — and the CLI's report/exit-code conventions (0 success, 2 usage/
 * config error, matching cli.ts's existing pattern for `lint`/`index`).
 */
import { readIdentity } from '../identity.js'
import { renamePass, type RenameReport } from '../rewrite.js'

export interface RenameArgs {
  oldAlias: string
  newAlias: string
  dryRun: boolean
}

/** `--dry-run` is the only flag; everything else is the two positional aliases. */
export function parseRename(rest: string[]): RenameArgs | { error: string } {
  let dryRun = false
  const positional: string[] = []
  for (const a of rest) {
    if (a === '--dry-run') dryRun = true
    else if (a.startsWith('--')) return { error: `unknown option ${a}` }
    else positional.push(a)
  }

  if (positional.length < 2) return { error: 'usage: rename <old> <new>' }
  if (positional.length > 2) return { error: 'rename takes exactly two arguments: <old> <new>' }

  const [oldAlias, newAlias] = positional as [string, string]
  return { oldAlias, newAlias, dryRun }
}

/**
 * Renames the implementation rooted at `dir` in place. `dir` is a parameter
 * (not `process.cwd()` read internally) so the verb stays testable without
 * touching the process's working directory — cli.ts passes `process.cwd()`
 * for the real invocation.
 */
export function runRename(
  dir: string,
  parsed: RenameArgs,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  let identity
  try {
    identity = readIdentity(dir)
  } catch (e) {
    err(`workflow: ${(e as Error).message}`)
    return 2
  }

  if (identity.alias !== parsed.oldAlias) {
    err(
      `workflow: <old> "${parsed.oldAlias}" does not match this tree's alias — ` +
        `.bffless/workflow.json declares "${identity.alias}"`,
    )
    return 2
  }

  let report: RenameReport
  try {
    report = renamePass(dir, parsed.oldAlias, parsed.newAlias, { dryRun: parsed.dryRun })
  } catch (e) {
    err(`workflow: ${(e as Error).message}`)
    return 2
  }

  // A cheap post-condition on the identity file specifically (the one file
  // `renamePass` treats as ordinary text but that this verb's own mismatch
  // guard, above, depends on reading correctly): after a real (non-dry-run)
  // rename, .bffless/workflow.json must actually say the new alias. This
  // can only fail if the boundary-aware textual pass missed the identity
  // file's own content — a bug in the engine, not something a caller can
  // trigger — but it's cheap to check and turns a silent-drift bug into a
  // loud one instead of a report that lied about what happened.
  if (!parsed.dryRun) {
    const after = readIdentity(dir)
    if (after.alias !== parsed.newAlias) {
      err(
        `workflow: rename reported success but .bffless/workflow.json still says "${after.alias}", ` +
          `not "${parsed.newAlias}" — this is a bug in the rename engine`,
      )
      return 2
    }
  }

  printReport(report, parsed, out)
  return 0
}

function printReport(report: RenameReport, parsed: RenameArgs, out: (line: string) => void): void {
  const tag = parsed.dryRun ? '(dry run) ' : ''
  for (const [from, to] of report.renames) out(`${tag}rename ${from} -> ${to}`)
  for (const e of report.edits) out(`${tag}edit ${e.file} (${e.count} match${e.count === 1 ? '' : 'es'})`)

  const dirNoun = report.renames.length === 1 ? 'directory' : 'directories'
  const fileNoun = report.edits.length === 1 ? 'file' : 'files'
  const verb = parsed.dryRun ? 'would rename' : 'renamed'
  out(
    `✔ ${verb} ${parsed.oldAlias} -> ${parsed.newAlias}: ` +
      `${report.renames.length} ${dirNoun}, ${report.edits.length} ${fileNoun} edited`,
  )
}
