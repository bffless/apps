import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Check { pass: boolean; evidence: unknown }

export interface WalkReport {
  walk: string
  harness: string
  ok: boolean
  blocked?: string
  runIds: string[]
  checks: Record<string, Check>
  notes: string[]
  spend: { studioKickoffs: number }
  started: string
  finished: string
}

export type Checker = Pick<Report, 'expect'>

export class Report {
  private readonly checks: Record<string, Check> = {}
  private readonly runIds: string[] = []
  private readonly notes: string[] = []
  private blocked?: string
  private kickoffs = 0
  private readonly started = new Date().toISOString()

  constructor(private readonly walk: string, private readonly harness: string) {}

  expect(name: string, cond: unknown, evidence?: unknown): boolean {
    if (Object.hasOwn(this.checks, name)) throw new Error(`duplicate check name: ${name}`)
    const pass = !!cond
    this.checks[name] = { pass, evidence: evidence ?? null }
    if (!pass) console.error(`FAIL ${name}: ${JSON.stringify(evidence)}`)
    return pass
  }
  note(text: string): void { this.notes.push(text) }
  run(id: string): void { if (!this.runIds.includes(id)) this.runIds.push(id) }
  kickoff(): void { this.kickoffs += 1 }
  // The first reason wins: a walk that blocks and then throws keeps its own
  // reason rather than `cli.ts`'s `walk threw: …`.
  block(reason: string): void {
    console.error(this.blocked === undefined ? `BLOCKED: ${reason}` : `BLOCKED (kept first reason): ${reason}`)
    this.blocked ??= reason
  }

  scoped(prefix: string): Checker {
    return { expect: (name, cond, evidence) => this.expect(`${prefix}${name}`, cond, evidence) }
  }

  /**
   * Run a throw-prone block whose checks are `names`. A throw inside `fn`
   * would otherwise escape to the CLI and read as BLOCKED (`src/cli.ts`),
   * which outranks any FAIL already recorded — so a red thing under test
   * reads as "precondition missing". Instead, every name in `names` that
   * `fn` did not get to record becomes a FAIL carrying the error (capped at
   * the CLI's 400 chars), and the guard resolves `false`: no rethrow, no
   * `block`, and the README's check rows stay stable. Resolves `true` when
   * `fn` returns; names it recorded are kept either way.
   */
  async guard(names: string[], fn: () => unknown): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (e) {
      const evidence = String(e).slice(0, 400)
      for (const name of names) if (!(name in this.checks)) this.expect(name, false, evidence)
      return false
    }
  }

  finish(): WalkReport {
    const ok = this.blocked === undefined && Object.values(this.checks).every((c) => c.pass)
    return {
      walk: this.walk, harness: this.harness, ok,
      ...(this.blocked === undefined ? {} : { blocked: this.blocked }),
      runIds: [...this.runIds], checks: { ...this.checks }, notes: [...this.notes],
      spend: { studioKickoffs: this.kickoffs }, started: this.started, finished: new Date().toISOString(),
    }
  }
}

export function exitCodeOf(r: WalkReport): 0 | 1 | 2 {
  if (r.blocked !== undefined) return 2
  return r.ok ? 0 : 1
}

export function toMarkdown(r: WalkReport): string {
  const lines: string[] = []
  if (r.blocked !== undefined) lines.push(`**BLOCKED — ${r.blocked}**`, '')
  for (const [name, c] of Object.entries(r.checks)) {
    lines.push(`- [${c.pass ? 'x' : ' '}] **${name} — ${c.pass ? 'PASS' : 'FAIL'}.** ${JSON.stringify(c.evidence)}`)
  }
  if (r.runIds.length) lines.push('', `Runs: ${r.runIds.map((id) => `\`${id}\``).join(', ')}`)
  if (r.notes.length) lines.push('') // otherwise Markdown folds the notes into the last list item
  for (const n of r.notes) lines.push(`> ${n}`)
  return `${lines.join('\n')}\n`
}

export async function writeReport(out: string, r: WalkReport): Promise<{ json: string; md: string }> {
  await mkdir(out, { recursive: true })
  const json = join(out, 'report.json')
  const md = join(out, 'report.md')
  await writeFile(json, `${JSON.stringify(r, null, 2)}\n`, 'utf8')
  await writeFile(md, toMarkdown(r), 'utf8')
  return { json, md }
}
