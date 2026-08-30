#!/usr/bin/env node
import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseWalkArgs, UsageError, USAGE } from './args.js'
import { Report, exitCodeOf, writeReport, type WalkReport } from './report.js'
import { ALL_ORDER, WALKS } from './walks/index.js'

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let args
  try { args = parseWalkArgs(argv) } catch (e) { console.error(e instanceof UsageError ? e.message : String(e)); return 2 }
  const names = args.walk === 'all' ? [...ALL_ORDER] : [args.walk]
  const reports: WalkReport[] = []
  for (const name of names) {
    const walk = WALKS[name]
    if (!walk) { console.error(`unknown walk ${name}\n\n${USAGE}`); return 2 }
    const out = names.length > 1 ? `${args.out}/${name}` : args.out
    await mkdir(out, { recursive: true })
    const report = new Report(name, args.harness)
    console.error(`walk ${name} → ${args.harness} (out: ${out})`)
    try { await walk({ args: { ...args, out }, env, report }) }
    catch (e) { report.block(`walk threw: ${String(e).slice(0, 400)}`) }
    const r = report.finish()
    const paths = await writeReport(out, r)
    console.log(JSON.stringify(r, null, 2))
    console.error(`${r.ok ? 'PASS' : r.blocked ? 'BLOCKED' : 'FAIL'} ${name} → ${paths.md}`)
    reports.push(r)
    if (r.blocked !== undefined) break
  }
  return Math.max(...reports.map(exitCodeOf)) as 0 | 1 | 2
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code })
