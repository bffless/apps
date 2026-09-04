import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ruleScopeOf } from '@bffless/workflow-agent-tools'

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
    const validators: { type: string; config?: { allowApiKey?: unknown; requiredScopes?: unknown } }[] = doc.pipeline.validators ?? []
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
      // The MCP endpoint (spec 10, D22) runs as the caller from Phase 3 story 7
      // (D23 rung 2): auth_required admits a member session or a Bearer app
      // token, with NO requiredScopes of its own — a token with any workflow
      // scope may connect; the tool's scope is checked per call (route.ts,
      // interim) and by each tool's own sibling rule from story 8. Every sibling
      // http_request forwards the caller's credential; the Phase-2 service
      // identity is gone.
      if (file.includes('/mcp/post/')) {
        expect(auth, `${file} must be auth_required (D23 rung 2)`).toBeDefined()
        expect(auth!.config?.allowApiKey).toBe(true)
        expect(auth!.config).not.toHaveProperty('requiredScopes')
        const steps: Array<{ id: string; handler: string; config?: Record<string, unknown> }> = doc.pipeline.steps
        expect(steps.find((s) => s.id === 'identity'), `${file}: the identity probe is retired`).toBeUndefined()
        for (const s of steps.filter((s) => s.handler === 'http_request')) {
          expect(s.config?.forwardAuth, `${file}: ${s.id} must forward the caller's credential`).toBe(true)
          expect(JSON.stringify(s.config?.headers ?? {}), `${file}: ${s.id} must not carry a service key`).not.toContain('WORKFLOW_MCP_KEY')
        }
      } else {
        expect(auth, `${file} (GET → 405) needs no validator`).toBeUndefined()
      }
      return
    }
    expect(auth, `${file} must be auth_required (D14)`).toBeDefined()
    // The global constraint names `allowApiKey` explicitly: CI (`workflow-ci`)
    // and the headless runner call every route with an API key, not a cookie.
    expect(auth!.config?.allowApiKey, `${file} must allow API keys (D14)`).toBe(true)
    // Every rule declares exactly the scope the catalog maps it to (spec 10 D23;
    // Phase 3 plan, Decision 27): an app token must carry it, a session never
    // needs it. The key is the rule's directory under rules/api/ plus its method.
    const key = file.slice(file.indexOf('/rules/api/') + '/rules/api/'.length).replace(/\/rule\.yaml$/, '').replace(/\.rule\.yaml$/, '')
    const scope = ruleScopeOf(key)
    expect(scope, `${file}: ${key} has no entry in RULE_SCOPES`).toBeDefined()
    expect(auth!.config?.requiredScopes, `${file} must declare requiredScopes [${scope}]`).toEqual([scope])
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
