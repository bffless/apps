import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'
import { ruleScopeOf, scopeOf } from '@bffless/workflow-agent-tools'

const ROOT = join(__dirname, '..', '.bffless', 'proxy-rules')
const KNOWN = new Set(['data_query', 'data_create', 'data_update', 'data_delete', 'data_upsert_many',
  'function_handler', 'response_handler', 'presigned_upload', 'register_upload', 'file_serve_handler',
  'file_delete', 'signed_url',
  // CE's http-request.handler.ts — how the MCP endpoint rule reaches its sibling
  // routes (a function_handler cannot fetch; spec 10 D22, Phase 2 plan Decision 5).
  'http_request',
  // CE's mcp.handler.ts — the MCP endpoint is one step of it from Phase 3 story 8 (spec 10, D22 GA).
  'mcp_handler',
  // CE's oauth-protected-resource.handler.ts — the RFC 9728 document, one step,
  // derived from the request and this set's own mcp_handler (spec 10, D23 rung 3).
  'oauth_protected_resource',
  // CE's github-api.handler.ts — how `run/drive` reaches an implementation's
  // workflow-drive.yml (repository_dispatch through the PROJECT's GitHub
  // integration, ADR-0006). The only step of the harness that leaves CE.
  'github_api'])

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
    '/run/lease/post/', '/run/delete/post/', '/run/fork/post/', '/run/drive/post/', '/whoami/get/',
    '/files/prepare/post/', '/files/register/post/', '/files/sign/post/',
    '/uploads/workflows/[...path]/',
    '/api/auth/',
  ],
}

/** Schemas each set ships, checked by name (`schemas/<name>.schema.yaml`). */
const SCHEMAS: Record<string, string[]> = {
  workflow: ['workflow_runs', 'workflow_run_steps', 'workflow_files', 'workflow_run_claims'],
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
      // protected-resource document cannot sit behind a session, so the rule
      // carries no validator. CE's `oauth_protected_resource` handler is the
      // whole answer — it derives the document from the request and the set's
      // own `mcp_handler`. CE's gate is an OR (`bypassVisibility ||
      // servesProtectedResourceDocument`), and this harness runs on PRIVATE
      // deployments, so we hold BOTH halves: the handler implies the bypass,
      // and the flag stays set so no one can drop the reachability we rely on.
      expect(auth, `${file} answers pre-credential discovery (spec 10, D23)`).toBeUndefined()
      expect(doc.pathPattern).toBe('/.well-known/oauth-protected-resource*')
      expect(doc.bypassVisibility, `${file} must stay reachable pre-credential`).toBe(true)
      const steps: {
        handler: string
        config?: { resource?: string; resourceName?: string; resourceDocumentation?: string }
      }[] = doc.pipeline.steps
      expect(steps.map((s) => s.handler)).toEqual(['oauth_protected_resource'])
      expect(steps[0].config?.resource).toBe('/api/workflow/mcp')
      // These two strings are the only part of the document still authored in this
      // repo — CE derives everything else — so nothing but this holds them.
      expect(steps[0].config?.resourceName).toBe('BFFless Workflow')
      expect(steps[0].config?.resourceDocumentation).toBe(
        'https://github.com/bffless/apps/blob/main/apps/workflow/docs/spec/10-agent-embedding.md',
      )
      return
    }
    if (file.includes('/api/workflow/mcp/')) {
      // The MCP endpoint (spec 10, D22 GA; Phase 3 story 8): ONE mcp_handler step,
      // its config rendered from the catalog (bundle.test.ts holds it fresh);
      // GET/POST/DELETE on one rule (the handler answers 405 to all but POST);
      // auth_required with NO requiredScopes of its own — any member session or
      // app token may connect, and each tool's scope is its sibling rule's.
      expect(doc.methods).toEqual(['GET', 'POST', 'DELETE'])
      expect(doc.pipeline.steps.map((s: { handler: string }) => s.handler)).toEqual(['mcp_handler'])
      expect(auth, `${file} must be auth_required (D23 rung 2)`).toBeDefined()
      expect(auth!.config?.allowApiKey).toBe(true)
      expect(auth!.config).not.toHaveProperty('requiredScopes')
      return
    }
    if (file.includes('/api/workflow/mcp-tools/') || file.includes('/api/workflow/mcp-resources/')) {
      // One sibling rule per tool: its validator carries exactly the tool's scope
      // (the catalog's map for the model-visible tools, the endpoint's for the
      // app-only four; the resources rules are reads), and every function step is
      // one of the shared bundles under mcp-fn/ — never a third copy of a tool.
      const dir = file.slice(file.indexOf('/api/workflow/') + '/api/workflow/'.length).split('/')
      const tool = dir[0] === 'mcp-tools' ? `workflow.${dir[1]}` : ''
      const HOST_SCOPES: Record<string, string> = { 'workflow.submit': 'workflow:run', 'workflow.annotate': 'workflow:run', 'workflow.pipeline': 'workflow:run', 'workflow.stepView': 'workflow:read' }
      const scope = tool === '' ? 'workflow:read' : (scopeOf(tool) ?? HOST_SCOPES[tool])
      expect(scope, `${file}: ${tool || 'resources'} has no scope`).toBeDefined()
      expect(auth, `${file} must be auth_required`).toBeDefined()
      expect(auth!.config?.requiredScopes, `${file} must require [${scope}]`).toEqual([scope])
      for (const s of doc.pipeline.steps as Array<{ handler: string; code?: string; config?: Record<string, unknown> }>) {
        if (s.handler === 'function_handler') expect(s.code, `${file}: function steps point at mcp-fn/`).toMatch(/^(\.\.\/)+mcp-fn\/(route|plan|merge|reply|runGate)\.fn\.js$/)
        if (s.handler === 'http_request') expect(s.config?.forwardAuth, `${file}: sibling calls run as the caller`).toBe(true)
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

  // A `code:` is resolved by the CLI against the rule's own directory, and a
  // rule six levels deep needs six `../` to reach `mcp-fn/` — one too few is a
  // sync-time "code file not found", far from the test that exercised the
  // bundle. Every function step names a file that is actually there.
  it.each(files)('%s points every function step at a file that exists', (file) => {
    const doc = parse(readFileSync(file, 'utf8'))
    if (doc.targetUrl !== 'pipeline') return
    for (const step of [...(doc.pipeline.steps ?? []), ...(doc.pipeline.postSteps ?? [])]) {
      if (step.handler !== 'function_handler') continue
      expect(typeof step.code, `${file}: ${step.id} has no code`).toBe('string')
      const resolved = join(file, '..', step.code)
      expect(statSync(resolved).isFile(), `${file}: ${step.id} → ${step.code}`).toBe(true)
    }
  })

  /**
   * The ownership boundary, rule by rule (spec 11 §One gate, not twenty-five
   * copies). Every rule file of the set falls in exactly one of three classes,
   * and each class has a shape:
   *
   * - **GATED** — it names an existing run, so it queries that run and judges
   *   it with the ONE shared gate (`mcp-fn/runGate.fn.js`), never with a
   *   hand-kept copy of the same four `if`s.
   * - **FILTERED** — a list endpoint, which cannot be gated (there is no one
   *   run): it has two `workflow_runs` queries, one filtered to the caller's
   *   own rows and one not, and the caller's `scope` picks which runs (D27).
   * - **NEITHER** — nothing here names a run, so the gate has nothing to say.
   *
   * A new rule must be placed in one of them, which is the point: the fence
   * fails on an unclassified file rather than letting an ungated route in.
   */
  const GATED = [
    '/run/get/', '/run/update/post/', '/run-step/post/', '/run/lease/post/', '/run/delete/post/', '/run/fork/post/', '/run/drive/post/',
    '/files/sign/post/', '/files/prepare/post/', '/files/register/post/', '/uploads/workflows/[...path]/',
    '/mcp-tools/status/', '/mcp-tools/await/', '/mcp-tools/outputs/', '/mcp-tools/sign/', '/mcp-tools/cancel/', '/mcp-tools/resume/', '/mcp-tools/submitStep/',
    '/mcp-tools/submit/', '/mcp-tools/annotate/', '/mcp-tools/pipeline/', '/mcp-tools/stepView/',
  ]
  const FILTERED = ['/runs/get/', '/mcp-tools/runs/']
  const NEITHER = [
    '/runs/post/', '/project/get/', '/aliases/get/', '/whoami/get/', '/mcp-tools/list/', '/mcp-tools/describe/', '/mcp-tools/start/',
    // `/mcp-resources/` names the resources INDEX (`mcp-resources/get/`) only;
    // `step-view` is its own route one level deeper, so it is listed in its own
    // right rather than inheriting the index's class through a loose prefix.
    '/_custom/well-known/', '/api/auth/', '/api/workflow/mcp/', '/mcp-resources/', '/mcp-resources/step-view/',
  ]
  const CLASSES: Array<[string, string[]]> = [['GATED', GATED], ['FILTERED', FILTERED], ['NEITHER', NEITHER]]
  /**
   * `/runs/post/` (NEITHER — the driver's own create) is also a substring of
   * `/mcp-tools/runs/post/` (FILTERED), the one overlap between the lists. The
   * specific fragment wins there; nothing else may match two classes.
   */
  const OVERLAP = '/rules/api/workflow/mcp-tools/runs/post/rule.yaml'
  const GATE_FILE = 'mcp-fn/runGate.fn.js'

  interface Step {
    id?: string
    handler: string
    code?: string
    config?: {
      schemaId?: string
      filters?: Record<string, { op?: string; value?: unknown } | undefined>
      condition?: string
      body?: string
    }
  }
  const stepsOf = (rel: string): Step[] => {
    const doc = parse(readFileSync(join(SET, rel), 'utf8')) as { pipeline?: { steps?: Step[] } }
    return doc.pipeline?.steps ?? []
  }

  /**
   * A fragment classifies a rule only where it is followed by that rule's OWN
   * file: `rule.yaml` or `<method>.rule.yaml`, optionally under ONE more
   * segment — and that segment must be a METHOD (`post/rule.yaml`) or a
   * catch-all param (`[...path]/any.rule.yaml`), never a named route. A bare
   * `.includes` let a rule inserted under an existing prefix inherit that
   * prefix's class unasked: both a hypothetical
   * `mcp-tools/list/stream/post/rule.yaml` and a `mcp-tools/list/stream/rule.yaml`
   * would have been read as `/mcp-tools/list/`'s NEITHER, i.e. an ungated route
   * waved through. Anchored, neither matches anything and the fence fails on
   * them, which is the point — a new route is placed deliberately or not at all.
   */
  const METHOD = '(?:get|post|put|patch|delete|head|options|any)'
  const RULE_TAIL = new RegExp(`^(?:(?:${METHOD}|\\[\\.\\.\\.[^/]+\\])/)?(?:${METHOD}\\.)?rule\\.yaml$`)
  const anchoredToRuleDir = (rel: string, fragment: string): boolean => {
    for (let i = rel.indexOf(fragment); i > -1; i = rel.indexOf(fragment, i + 1)) {
      if (RULE_TAIL.test(rel.slice(i + fragment.length))) return true
    }
    return false
  }

  /**
   * Does a step sitting past `runGate` actually trace to it? The gate being
   * present says nothing about it being honored — a later step left
   * unconditioned, or conditioned on something unrelated, runs for a caller the
   * gate refused. Every such step must reach the gate one of three ways (the
   * shapes surveyed across all 22 GATED rules in apps#674):
   *
   * - **(a) direct** — its own `condition` names `steps.runGate`.
   * - **(b) delegated** — its condition names another step of the rule that
   *   itself traces, recursively (`files` on `steps.gate.ok`, `gate` on
   *   `steps.runGate.ok`).
   * - **(c) self-gating** — it carries NO condition, and either (c1) it is a
   *   `function_handler` whose own code reads `steps.runGate`, or (c2) it is a
   *   `response_handler` rendering nothing but such a step's output
   *   (`{{{steps.shape}}}`, `{{{steps.reply.json}}}`) — the same "bare output
   *   of one step" reading the `driveKey` fence below already uses.
   *
   * (a)/(b) are tried FIRST and (c) only for a step with no condition at all, so
   * a comment merely mentioning `steps.runGate` — as `run/delete`, `run/fork`
   * and `run/lease`'s local `gate.fn.js` each do, harmlessly, being gated by
   * shape (a) — can never stand in for a real property read. Comment lines are
   * skipped for the same reason.
   *
   * Shape (a) accepts any condition NAMING the gate, `steps.runGate.notFound`
   * included: the 404 responders are refusals, and a refusal is as much an
   * honouring of the gate as a success path. So what this proves is that no step
   * past the gate runs without consulting it — which sense of the gate a given
   * step takes is the rule's own business, and is read by review.
   *
   * Returns `null` when the step traces, or the reason it does not.
   */
  /**
   * The functions allowed to gate themselves (shape c1), by set-relative path.
   * An allowlist rather than "any file containing the string", because these
   * `.fn.js` are esbuild BUNDLES: `merge.fn.js` and `plan.fn.js` carry
   * `steps.runGate` through the inlined `admittedRun` helper, so a future bundle
   * could inherit the token from its import graph without its own entry ever
   * reading the gate — and pass a fence that only grepped. Membership is
   * deliberate; the read is still checked (below, and by `every entry … really
   * reads it`), so a listed file that stops reading the gate fails too.
   */
  const SELF_GATING = new Set(
    [
      'mcp-fn/runGate.fn.js',
      'mcp-fn/merge.fn.js',
      'mcp-fn/plan.fn.js',
      'mcp-fn/reply.fn.js',
      'mcp-fn/driveGate.fn.js',
      'rules/api/workflow/run/get/shape.fn.js',
    ].map((p) => join(SET, p)),
  )
  const readsGate = (file: string): boolean =>
    existsSync(file) &&
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
      .some((line) => /steps\.runGate\b/.test(line))
  const selfGates = (ruleDir: string, code: string | undefined, allowed: Set<string>): boolean => {
    if (!code) return false
    const resolved = join(ruleDir, code)
    return allowed.has(resolved) && readsGate(resolved)
  }
  const tracesToRunGate = (
    steps: Step[],
    step: Step,
    ruleDir: string,
    allowed: Set<string> = SELF_GATING,
    seen = new Set<string>(),
  ): string | null => {
    if (step.id === 'runGate') return null
    const byId = (id: string) => steps.find((s) => s.id === id)
    const traced = (id: string): boolean => {
      if (seen.has(id)) return false // a condition cycle traces to nothing
      const via = byId(id)
      return !!via && tracesToRunGate(steps, via, ruleDir, allowed, new Set([...seen, id])) === null
    }
    const condition = step.config?.condition
    if (condition) {
      if (/steps\.runGate\b/.test(condition)) return null // (a)
      const named = [...condition.matchAll(/steps\.(\w+)/g)].map((m) => m[1])
      if (named.some(traced)) return null // (b)
      return `condition \`${condition}\` traces to no gated step`
    }
    if (step.handler === 'function_handler' && selfGates(ruleDir, step.code, allowed)) return null // (c1)
    if (step.handler === 'response_handler') {
      const bare = String(step.config?.body ?? '').match(/^\{\{\{steps\.(\w+)(?:\.[\w.]+)?\}\}\}$/)
      if (bare && (bare[1] === 'runGate' || traced(bare[1]))) return null // (c2)
    }
    return `is unconditioned (${step.handler}) and neither reads \`steps.runGate\` itself nor renders a step that does`
  }

  it('classifies every rule against the ownership boundary (spec 11)', () => {
    const classesOf = (rel: string) =>
      CLASSES.filter(([, fragments]) => fragments.some((f) => anchoredToRuleDir(rel, f))).map(([cls]) => cls)
    const classified: Record<string, string[]> = { GATED: [], FILTERED: [], NEITHER: [] }

    for (const file of files) {
      const rel = file.slice(SET.length)
      const hit = classesOf(rel)
      if (rel === OVERLAP) expect(hit, `${rel} is the one known overlap`).toEqual(['FILTERED', 'NEITHER'])
      else expect(hit, `${rel} must be in exactly one class of the ownership boundary (spec 11) — place it`).toHaveLength(1)
      classified[hit[0]].push(rel)
    }
    // Every fragment names a rule that is really there, so a route that is
    // renamed or retired cannot leave a dead entry standing in for it.
    for (const [cls, fragments] of CLASSES) {
      for (const fragment of fragments) {
        expect(files.some((f) => anchoredToRuleDir(f.slice(SET.length), fragment)), `${cls}: ${fragment} matches no rule`).toBe(true)
      }
    }
    expect(classified.GATED.length + classified.FILTERED.length + classified.NEITHER.length).toBe(files.length)

    for (const rel of classified.GATED) {
      const steps = stepsOf(rel)
      const runAt = steps.findIndex((s) => s.id === 'run' && s.handler === 'data_query' && s.config?.schemaId === '$schema:workflow_runs')
      expect(runAt, `${rel} names a run: it must query it (data_query \`run\` on $schema:workflow_runs)`).toBeGreaterThan(-1)
      const gateAt = steps.findIndex((s) => s.handler === 'function_handler' && s.id === 'runGate' && String(s.code).endsWith(GATE_FILE))
      expect(gateAt, `${rel} must judge that run with the shared gate (a \`runGate\` function step on ${GATE_FILE})`).toBeGreaterThan(-1)
      expect(gateAt, `${rel}: the gate must come after the \`run\` query it judges`).toBeGreaterThan(runAt)
      // Present is not honored: every step past the gate must trace back to it.
      const ruleDir = join(SET, rel, '..')
      for (const s of steps.slice(gateAt + 1)) {
        expect(
          tracesToRunGate(steps, s, ruleDir),
          `${rel}: step \`${s.id}\` runs past the gate but does not trace to it — condition it on \`steps.runGate.ok\`, on a step that is, or read the gate in its own code (spec 11 §One gate, not twenty-five copies)`,
        ).toBeNull()
      }
    }

    for (const rel of classified.FILTERED) {
      const text = readFileSync(join(SET, rel), 'utf8')
      const queries = stepsOf(rel).filter((s) => s.handler === 'data_query' && s.config?.schemaId === '$schema:workflow_runs')
      const mine = queries.filter((s) => s.config?.filters?.startedBy?.value === 'user.id')
      expect(mine.length, `${rel} lists runs: one query must filter startedBy on user.id`).toBe(1)
      expect(queries.length - mine.length, `${rel}: and a second, unfiltered one for an asked-for scope=all (D27)`).toBe(1)
      expect(text.includes(GATE_FILE), `${rel} is filtered, not gated — there is no one run to judge`).toBe(false)
    }

    for (const rel of classified.NEITHER) {
      expect(readFileSync(join(SET, rel), 'utf8').includes(GATE_FILE), `${rel} names no run — it must not reference the gate`).toBe(false)
    }
  })

  /**
   * The check above only ever sees rules that already pass it, so it is proved
   * here against a rule that does not: the same `tracesToRunGate` over a
   * hand-built `Step[]` (nothing on disk) whose `steps` query is left
   * unconditioned with no self-gating function behind it — the exact shape
   * apps#674 was filed about. Conditioning that one step is the whole
   * difference between flagged and clean.
   */
  it('flags a step past the gate that traces to nothing (the assertion above, proved)', () => {
    // A rule of its own, on a scratch dir: every function this fixture reads is
    // written here, so neither direction of the shape-(c1) case depends on what
    // a generated `mcp-fn/*.fn.js` bundle happens to contain today.
    const DIR = mkdtempSync(join(tmpdir(), 'rules-fence-'))
    writeFileSync(join(DIR, 'gatekeeper.fn.js'), 'function handler({ steps }) {\n  return { ok: !!(steps.runGate && steps.runGate.ok) }\n}\n')
    writeFileSync(join(DIR, 'blind.fn.js'), 'function handler({ steps }) {\n  return { ok: !!steps.run }\n}\n')
    // Contains the token — inlined from a shared helper it never calls — but is
    // not on the list, which is the case the allowlist exists for.
    writeFileSync(join(DIR, 'inlined.fn.js'), 'function admittedRun(steps) {\n  const gate = steps.runGate;\n  return gate && gate.ok\n}\nfunction handler({ steps }) {\n  return { ok: !!steps.run }\n}\n')
    const ALLOWED = new Set([join(DIR, 'gatekeeper.fn.js')])

    const rule = (condition?: string): Step[] => [
      { id: 'run', handler: 'data_query', config: { schemaId: '$schema:workflow_runs' } },
      { id: 'runGate', handler: 'function_handler', code: './gatekeeper.fn.js' },
      { id: 'steps', handler: 'data_query', config: { schemaId: '$schema:workflow_run_steps', condition } },
      { id: 'respond', handler: 'response_handler', config: { body: '{{{steps.steps}}}' } },
    ]
    const traces = (steps: Step[], step: Step) => tracesToRunGate(steps, step, DIR, ALLOWED)

    const ungated = rule()
    expect(traces(ungated, ungated[2])).toMatch(/unconditioned/)
    // …and the bare responder over it inherits the hole, rather than papering over it.
    expect(traces(ungated, ungated[3])).not.toBeNull()

    // Conditioned on something real but unrelated is still not the gate.
    const unrelated = rule('steps.run.length')
    expect(traces(unrelated, unrelated[2])).toMatch(/traces to no gated step/)

    // Shape (a), and shape (c2) delegating to it.
    const gated = rule('steps.runGate.ok')
    expect(traces(gated, gated[2])).toBeNull()
    expect(traces(gated, gated[3])).toBeNull()

    // Shape (c1): no condition, but the function is allowed to gate itself and
    // really reads the gate. Its two near-misses are both refused — a function
    // that does not read the gate, and one that carries the token without being
    // on the list.
    const fn = (id: string, code: string): Step[] => [...gated.slice(0, 3), { id, handler: 'function_handler', code }]
    const self = fn('shape', './gatekeeper.fn.js')
    expect(traces(self, self[3])).toBeNull()
    const blind = fn('shape', './blind.fn.js')
    expect(traces(blind, blind[3])).not.toBeNull()
    const inlined = fn('shape', './inlined.fn.js')
    expect(traces(inlined, inlined[3])).not.toBeNull()

    rmSync(DIR, { recursive: true, force: true })
  })

  /** Every entry of the allowlist is a real file that really reads the gate, so
   * the list cannot outlive what it permits. */
  it('every self-gating function on the allowlist really reads the gate', () => {
    for (const file of SELF_GATING) {
      expect(existsSync(file), `${file.slice(SET.length)} is on the self-gating list but is not there`).toBe(true)
      expect(readsGate(file), `${file.slice(SET.length)} is on the self-gating list but does not read steps.runGate`).toBe(true)
    }
  })

  /**
   * The anchoring itself, as a table — the claim "never a deeper route" is
   * otherwise only visible by adding a rule file and watching the fence fail.
   */
  it.each([
    ['/mcp-tools/list/', '/rules/api/workflow/mcp-tools/list/post/rule.yaml', true],
    ['/mcp-tools/list/', '/rules/api/workflow/mcp-tools/list/stream/post/rule.yaml', false],
    ['/mcp-tools/list/', '/rules/api/workflow/mcp-tools/list/stream/rule.yaml', false],
    ['/run/get/', '/rules/api/workflow/run/get/rule.yaml', true],
    ['/run/get/', '/rules/api/workflow/runs/get/rule.yaml', false],
    ['/mcp-resources/', '/rules/api/workflow/mcp-resources/get/rule.yaml', true],
    ['/mcp-resources/', '/rules/api/workflow/mcp-resources/step-view/get/rule.yaml', false],
    ['/mcp-resources/step-view/', '/rules/api/workflow/mcp-resources/step-view/get/rule.yaml', true],
    ['/api/auth/', '/rules/api/auth/[...path]/any.rule.yaml', true],
    ['/_custom/well-known/', '/rules/_custom/well-known/get.rule.yaml', true],
  ])('anchors %s against %s', (fragment, rel, expected) => {
    expect(anchoredToRuleDir(rel, fragment)).toBe(expected)
  })

  // `driveKey` (spec 11 D28) is a column on `workflow_runs`, never something a
  // response body may carry. A `response_handler` that renders a `data_create`
  // or `data_query` step's OWN output verbatim — `{{{steps.<id>}}}`, no
  // shaping step in between — would ship the row (and the nonce) unfiltered;
  // `run/get`, `runs/get` and `runs/post` all interpose a `shape` step
  // (apps#665 follow-up) precisely so this can never be the wire.
  it('never answers a bare workflow_runs row — every response_handler body naming a data_create/data_query step on it must be a shaping step\'s own output, not the query\'s', () => {
    for (const file of files) {
      const doc = parse(readFileSync(file, 'utf8')) as { pipeline?: { steps?: Array<Step & { config?: { body?: string } }> } }
      const steps = doc.pipeline?.steps ?? []
      const rawRunSteps = new Set(
        steps
          .filter((s) => (s.handler === 'data_create' || s.handler === 'data_query') && s.config?.schemaId === '$schema:workflow_runs')
          .map((s) => s.id),
      )
      for (const s of steps) {
        if (s.handler !== 'response_handler') continue
        const match = String(s.config?.body ?? '').match(/^\{\{\{steps\.(\w+)\}\}\}$/)
        if (!match) continue
        expect(rawRunSteps.has(match[1]), `${file}: response_handler '${s.id}' renders steps.${match[1]} — a raw workflow_runs row — verbatim; interpose a shaping step that strips driveKey`).toBe(false)
      }
    }
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
