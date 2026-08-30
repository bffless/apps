import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parseRecord, type RunRecord } from './record.js'

export function driverCliPath(): string {
  const entry = createRequire(import.meta.url).resolve('@bffless/workflow-headless')   // …/dist/index.js
  return join(dirname(entry), 'cli.js')
}

export interface DriverOutcome { code: number; stdout: string; stderr: string; record?: RunRecord; runId?: string }
export interface DriverOptions { harness: string; target: string; inputs: unknown; out: string; timeoutMs: number; env: NodeJS.ProcessEnv }

export function outcomeOf(code: number): 'succeeded' | 'failed' | 'driver-fault' | 'invalid' | 'timeout' | 'interrupted' {
  return code === 0 ? 'succeeded' : code === 1 ? 'failed' : code === 3 ? 'invalid' : code === 4 ? 'timeout' : code === 130 ? 'interrupted' : 'driver-fault'
}

export async function runDriver(o: DriverOptions): Promise<DriverOutcome> {
  await mkdir(o.out, { recursive: true })
  const inputsFile = join(o.out, 'inputs.json')
  await writeFile(inputsFile, JSON.stringify(o.inputs), 'utf8')
  const driverOut = join(o.out, 'driver')
  const args = [driverCliPath(), 'run', o.harness, o.target, '--inputs', inputsFile, '--out', driverOut, '--timeout', `${Math.ceil(o.timeoutMs / 1000)}s`]
  // `||`, not `??`: CI interpolates an unset secret as `''`, which `??` would let through.
  const childEnv = { ...o.env, WORKFLOW_EMAIL: o.env.WORKFLOW_EMAIL || o.env.WORKFLOW_CI_EMAIL, WORKFLOW_PASSWORD: o.env.WORKFLOW_PASSWORD || o.env.WORKFLOW_CI_PASSWORD }
  const child = spawn(process.execPath, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (d) => { stdout += d; process.stderr.write(d) })
  child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d) })
  const code: number = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 2)))
  const outcome: DriverOutcome = { code, stdout, stderr }
  const recordPath = join(driverOut, 'run.json')
  if (existsSync(recordPath)) {
    try {
      outcome.record = parseRecord(JSON.parse(await readFile(recordPath, 'utf8')))
      if (outcome.record.run?.runId) outcome.runId = outcome.record.run.runId
    } catch (e) { outcome.stderr += `\nrun.json unreadable: ${String(e)}` }
  }
  return outcome
}
