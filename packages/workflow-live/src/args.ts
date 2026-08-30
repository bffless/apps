import { parseDuration } from '@bffless/workflow-headless'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export class UsageError extends Error {}

export const USAGE = `workflow-live walk <m1|interactive|hello|headless|studio-audit|studio-headless|all>
  [--harness https://workflow.j5s.dev] [--out DIR] [--dispatch] [--clip PATH] [--run RUN_ID] [--timeout 90m]

env: WORKFLOW_EMAIL/WORKFLOW_PASSWORD (or WORKFLOW_CI_EMAIL/WORKFLOW_CI_PASSWORD); optional ADMIN_API_KEY
exit: 0 all checks passed · 1 a check failed · 2 blocked (precondition missing / driver fault)`

export interface WalkArgs {
  walk: string
  harness: string
  out: string
  dispatch: boolean
  clip?: string
  run?: string
  timeoutMs: number
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

export function parseWalkArgs(argv: string[]): WalkArgs {
  const [command, walk, ...rest] = argv
  if (command !== 'walk') throw new UsageError(USAGE)
  if (!walk || walk.startsWith('--')) throw new UsageError(USAGE)
  const a: WalkArgs = { walk, harness: 'https://workflow.j5s.dev', out: '', dispatch: false, timeoutMs: parseDuration('90m') }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const value = () => {
      const v = rest[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value\n\n${USAGE}`)
      return v
    }
    if (flag === '--harness') a.harness = value().replace(/\/+$/, '')
    else if (flag === '--out') a.out = value()
    else if (flag === '--dispatch') a.dispatch = true
    else if (flag === '--clip') a.clip = value()
    else if (flag === '--run') a.run = value()
    else if (flag === '--timeout') {
      try {
        a.timeoutMs = parseDuration(value())
      } catch (e) {
        throw new UsageError(`--timeout: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`)
      }
    } else throw new UsageError(`unknown flag ${flag}\n\n${USAGE}`)
  }
  if (!a.out) a.out = join(tmpdir(), 'workflow-live', walk, stamp())
  return a
}
