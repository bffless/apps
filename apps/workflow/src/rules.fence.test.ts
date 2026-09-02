import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const ROOT = join(__dirname, '..', '.bffless', 'proxy-rules')
const KNOWN = new Set(['data_query', 'data_create', 'data_update', 'data_delete', 'data_upsert_many',
  'function_handler', 'response_handler', 'presigned_upload', 'register_upload', 'file_serve_handler',
  'file_delete', 'signed_url',
  // CE's http-request.handler.ts — how the MCP endpoint rule reaches its sibling
  // routes (a function_handler cannot fetch; spec 10 D22, Phase 2 plan Decision 5).
  'http_request'])

function ruleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return ruleFiles(p)
    return /rule\.yaml$/.test(n) ? [p] : []
  })
}

/**
 * Path fragments each set's rule files must include, one per required route.
 * `hello` moved out of this repo (`bffless/workflow-implementations`, M3 Task 7 + M4) — that
 * repo's own tests hold its rule set to its own surface now, not this one.
 */
const SURFACE: Record<string, string[]> = {
  workflow: [
    '/runs/post/', '/runs/get/', '/run/get/', '/run/update/post/', '/run-step/post/',
    '/run/lease/post/', '/run/delete/post/', '/run/fork/post/', '/whoami/get/',
    '/files/prepare/post/', '/files/register/post/', '/files/sign/post/',
    '/uploads/workflows/[...path]/',
    '/api/auth/',
  ],
}

/** Schemas each set ships, checked by name (`schemas/<name>.schema.yaml`). */
const SCHEMAS: Record<string, string[]> = {
  workflow: ['workflow_runs', 'workflow_run_steps', 'workflow_files'],
}

/**
 * The record shape `register_upload` writes, whatever the target schema declares
 * (ce `upload-schema-contract.ts` `UPLOAD_RECORD_FIELDS` →
 * `UploadRecordService.createUploadRecords`). A schema that does not declare these
 * is describing something its own rows aren't — which is how `workflow_files` came
 * to declare `fileName`/`storagePath`/`contentType` while CE wrote
 * `filename`/`storage_path`/… (apps#381). Harmless drift until the run-delete rule
 * started filtering on `storage_path`; fenced here so it cannot come back.
 */
const UPLOAD_RECORD_FIELDS: Record<string, string> = {
  filename: 'string',
  storage_path: 'string',
  content_type: 'string',
  size: 'number',
  url: 'string',
  sub_dir: 'string',
  original_name: 'string',
}

describe.each(['workflow'])('%s rule set fence', (name) => {
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
      if (s.handler !== 'data_query') continue
      // CE's data-query.handler.ts reads `limit` (default 100) and has no
      // `pageSize` option, so a `pageSize: 1000` silently capped run/get at 100
      // step rows and truncated replay (apps#512). Every query names its cap
      // by the key CE reads, and the inert one cannot come back.
      expect(typeof s.config?.limit, `${file}: ${s.id} data_query must set a numeric limit`).toBe('number')
      expect(s.config, `${file}: ${s.id} data_query must not use pageSize (inert; use limit)`).not.toHaveProperty(
        'pageSize',
      )
    }
    const validators: { type: string; config?: { allowApiKey?: unknown } }[] = doc.pipeline.validators ?? []
    const auth = validators.find((v) => v.type === 'auth_required')
    if (file.includes('/_custom/well-known/')) {
      // OAuth discovery happens before any credential exists (RFC 9728): the
      // 404 that says "no metadata here" cannot sit behind a session. Phase 3's
      // real protected-resource document replaces it, equally unauthenticated.
      expect(auth, `${file} answers pre-credential discovery (spec 10, D23)`).toBeUndefined()
      expect(doc.pathPattern).toBe('/.well-known/*')
      return
    }
    if (file.includes('/api/workflow/mcp/')) {
      // The MCP endpoint (spec 10, D22) is authless by design in Phase 2 — auth
      // ladder rung 1 (D23): claude.ai connects to an authless server on a scratch
      // public project, and a session validator would refuse it before any rule
      // ran. Its gate is the `identity` step instead: every sibling call carries
      // the WORKFLOW_MCP_KEY service identity, and without that secret the rule
      // answers "not enabled" to everything but initialize (Phase 2 plan,
      // Decision 6). Phase 3 puts app tokens + requiredScopes in front (story 7).
      expect(auth, `${file} is the authless prototype endpoint (D23 rung 1)`).toBeUndefined()
      if (file.includes('/mcp/post/')) {
        const identity = doc.pipeline.steps.find((s: { id: string }) => s.id === 'identity')
        expect(identity?.handler, `${file}: the identity probe is the endpoint's gate`).toBe('http_request')
        expect(identity?.config?.headers?.['x-api-key'], `${file}: identity carries the service key`).toBe('secrets.WORKFLOW_MCP_KEY')
      }
      return
    }
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

  it('declares the upload-record contract on every schema a register_upload step writes', () => {
    const targets = new Set<string>()
    for (const file of files) {
      const doc = parse(readFileSync(file, 'utf8'))
      if (doc.targetUrl !== 'pipeline') continue
      for (const step of doc.pipeline.steps ?? []) {
        if (step.handler !== 'register_upload') continue
        targets.add(String(step.config?.schemaId ?? '').replace(/^\$schema:/, ''))
      }
    }
    expect(targets.size, `${name} must have at least one register_upload step`).toBeGreaterThan(0)

    for (const schema of targets) {
      const doc = parse(readFileSync(join(SET, 'schemas', `${schema}.schema.yaml`), 'utf8'))
      const declared: Record<string, string> = Object.fromEntries(
        (doc.fields ?? []).map((f: { name: string; type: string }) => [f.name, f.type]),
      )
      for (const [field, type] of Object.entries(UPLOAD_RECORD_FIELDS)) {
        // `text` holds a string just as well as `string` does (ce `isCompatible`).
        const ok = declared[field] === type || (type === 'string' && declared[field] === 'text')
        expect(ok, `${schema} must declare ${field}: ${type}, not ${declared[field] ?? '(absent)'}`).toBe(
          true,
        )
      }
    }
  })
})
