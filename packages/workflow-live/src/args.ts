import { parseDuration, UsageError } from '@bffless/workflow-headless'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The same `UsageError` the headless driver throws (it sets `name`), so a stack
// says `UsageError`, not `Error`; re-exported so importers keep using `./args.js`.
export { UsageError }

export const USAGE = `workflow-live walk <m1|interactive|hello|headless|studio-audit|studio-headless|page-tools|mcp|oauth|all>
  [--harness https://workflow.j5s.dev] [--out DIR] [--dispatch] [--clip PATH] [--run RUN_ID] [--park-only] [--timeout 90m]

env: WORKFLOW_EMAIL/WORKFLOW_PASSWORD (or WORKFLOW_CI_EMAIL/WORKFLOW_CI_PASSWORD); optional ADMIN_API_KEY; optional WORKFLOW_APP_TOKEN (mcp: skips the walk's own mint)
exit: 0 all checks passed · 1 a check failed · 2 blocked (precondition missing / driver fault)`

export interface WalkArgs {
  walk: string
  harness: string
  out: string
  dispatch: boolean
  clip?: string
  run?: string
  /** `mcp`: park a run on its island through the page tools, print the id, stop. */
  parkOnly: boolean
  timeoutMs: number
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

export function parseWalkArgs(argv: string[]): WalkArgs {
  const [command, walk, ...rest] = argv
  if (command !== 'walk') throw new UsageError(USAGE)
  if (!walk || walk.startsWith('--')) throw new UsageError(USAGE)
  const a: WalkArgs = { walk, harness: 'https://workflow.j5s.dev', out: '', dispatch: false, parkOnly: false, timeoutMs: parseDuration('90m') }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = () => {
      const v = rest[++i]
      if (v === undefined || v === '' || v.startsWith('--')) throw new UsageError(`${flag} needs a value\n\n${USAGE}`)
      return v
    }
    if (flag === '--harness') {
      const harness = value().replace(/\/+$/, '')
      if (!harness) throw new UsageError(`${flag} needs a value\n\n${USAGE}`)
      a.harness = harness
    }
    else if (flag === '--out') a.out = value()
    else if (flag === '--dispatch') a.dispatch = true
    else if (flag === '--park-only') a.parkOnly = true
    else if (flag === '--clip') a.clip = value()
    else if (flag === '--run') a.run = value()
    else if (flag === '--timeout') {
      const v = value() // a missing value is already a UsageError; only parseDuration's error is wrapped
      try {
        a.timeoutMs = parseDuration(v)
      } catch (e) {
        throw new UsageError(`--timeout: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`)
      }
    } else throw new UsageError(`unknown flag ${flag}\n\n${USAGE}`)
  }
  if (!a.out) a.out = join(tmpdir(), 'workflow-live', walk, stamp())
  return a
}
