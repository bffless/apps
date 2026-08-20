import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const SET = join(__dirname, '..', '.bffless', 'proxy-rules', 'workflow')
const KNOWN = new Set(['data_query', 'data_create', 'data_update', 'function_handler',
  'response_handler', 'presigned_upload', 'register_upload', 'file_serve_handler'])

function ruleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return ruleFiles(p)
    return /rule\.yaml$/.test(n) ? [p] : []
  })
}

describe('workflow rule set fence', () => {
  const files = ruleFiles(join(SET, 'rules'))
  it('ships the full API surface', () => {
    const rel = files.map((f) => f.slice(SET.length))
    expect(rel.some((p) => p.includes('/runs/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/runs/get/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run/get/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run/update/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run-step/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/run/lease/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/files/prepare/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/files/register/post/'))).toBe(true)
    expect(rel.some((p) => p.includes('/files/[...path]/'))).toBe(true)
    expect(rel.some((p) => p.includes('/api/auth/'))).toBe(true)
  })
  it.each(files)('%s parses, uses known handlers, and gates auth', (file) => {
    const doc = parse(readFileSync(file, 'utf8'))
    expect(doc.targetUrl).toBeDefined()
    if (doc.targetUrl !== 'pipeline') return // forwarding rules (auth relay) are exempt
    for (const s of [...(doc.pipeline.steps ?? []), ...(doc.pipeline.postSteps ?? [])]) {
      expect(KNOWN.has(s.handler), `${file}: ${s.handler}`).toBe(true)
    }
    const validators = doc.pipeline.validators ?? []
    expect(validators.some((v: { type: string }) => v.type === 'auth_required'),
      `${file} must be auth_required (D14)`).toBe(true)
  })
  it('ships the three schemas', () => {
    for (const s of ['workflow_runs', 'workflow_run_steps', 'workflow_files']) {
      const doc = parse(readFileSync(join(SET, 'schemas', `${s}.schema.yaml`), 'utf8'))
      expect(doc.name).toBe(s)
    }
  })
})
