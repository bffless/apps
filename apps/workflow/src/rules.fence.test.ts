import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const ROOT = join(__dirname, '..', '.bffless', 'proxy-rules')
const KNOWN = new Set(['data_query', 'data_create', 'data_update', 'function_handler',
  'response_handler', 'presigned_upload', 'register_upload', 'file_serve_handler'])

function ruleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return ruleFiles(p)
    return /rule\.yaml$/.test(n) ? [p] : []
  })
}

/** Path fragments each set's rule files must include, one per required route. */
const SURFACE: Record<string, string[]> = {
  workflow: [
    '/runs/post/', '/runs/get/', '/run/get/', '/run/update/post/', '/run-step/post/',
    '/run/lease/post/', '/files/prepare/post/', '/files/register/post/', '/uploads/workflows/[...path]/',
    '/api/auth/',
  ],
  hello: [
    '/hello/echo/post/', '/hello/slow/post/', '/hello/job/get/', '/hello/fail/post/',
    '/hello/analyze/post/', '/w/hello/[...path]/',
  ],
}

/** Schemas each set ships, checked by name (`schemas/<name>.schema.yaml`). */
const SCHEMAS: Record<string, string[]> = {
  workflow: ['workflow_runs', 'workflow_run_steps', 'workflow_files'],
  hello: ['hello_jobs'],
}

describe.each(['workflow', 'hello'])('%s rule set fence', (name) => {
  const SET = join(ROOT, name)
  const files = ruleFiles(join(SET, 'rules'))

  it('ships the full API surface', () => {
    const rel = files.map((f) => f.slice(SET.length))
    for (const fragment of SURFACE[name]) {
      expect(rel.some((p) => p.includes(fragment)), fragment).toBe(true)
    }
  })

  it.each(files)('%s parses, uses known handlers, and gates auth', (file) => {
    const doc = parse(readFileSync(file, 'utf8'))
    expect(doc.targetUrl).toBeDefined()
    if (doc.targetUrl !== 'pipeline') return // forwarding rules (auth relay / D2 single-origin) are exempt
    for (const s of [...(doc.pipeline.steps ?? []), ...(doc.pipeline.postSteps ?? [])]) {
      expect(KNOWN.has(s.handler), `${file}: ${s.handler}`).toBe(true)
    }
    const validators: { type: string; config?: { allowApiKey?: unknown } }[] = doc.pipeline.validators ?? []
    const auth = validators.find((v) => v.type === 'auth_required')
    expect(auth, `${file} must be auth_required (D14)`).toBeDefined()
    // The global constraint names `allowApiKey` explicitly: CI (`workflow-ci`)
    // and the headless runner call every route with an API key, not a cookie.
    expect(auth!.config?.allowApiKey, `${file} must allow API keys (D14)`).toBe(true)
  })

  it('ships its schemas', () => {
    for (const s of SCHEMAS[name]) {
      const doc = parse(readFileSync(join(SET, 'schemas', `${s}.schema.yaml`), 'utf8'))
      expect(doc.name).toBe(s)
    }
  })
})
