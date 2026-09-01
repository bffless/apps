/**
 * `workflow publish` (apps#420, plan Decision 8:
 * docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:24) — the four
 * moves `bffless/publish-workflow`'s action makes, driven by this CLI
 * in-process instead of composing three separate GitHub Actions:
 *
 *   1. index     — `buildIndex` (via ../index-bundle.js's `writeIndexBundle`,
 *                  the exact machinery `workflow index` itself uses — Task 1)
 *   2. prepare   — the alias-named copy + generated `/w/<alias>/*` forwarder
 *                  (../prepare.js, a port of publish-workflow's
 *                  scripts/prepare-rules.mjs)
 *   3. rules push — spawns the published `bffless` CLI (`npx --yes
 *                  bffless@0.3.3 rules push`) rather than re-implementing
 *                  the compiler/sync client — a downward platform dependency,
 *                  permitted by the 2026-08-31 ruling (the reverse is not)
 *   4. upload + attach — a multipart zip deploy to `/api/deployments/zip`
 *                  (typed against `@bffless/artifact-client`'s shared
 *                  `UploadResponse`), then a ported `attach.mjs`: union the
 *                  newly-synced rule set's id into the harness alias's own
 *                  `proxyRuleSetIds` (idempotent — publishing the same
 *                  implementation twice is a no-op)
 *
 * Credentials: `--api-url` (or `BFFLESS_API_URL`) plus `BFFLESS_API_KEY` from
 * the environment ONLY — never a flag (an API key on the command line lands
 * in the process list; same rationale as publish-workflow's own
 * scripts/attach.mjs). A missing key exits 2 before any network call — the
 * check runs immediately after resolving flags/identity (all local, no I/O
 * beyond a single file read), strictly before move 1.
 *
 * `--dry-run` prints all four moves with every value fully resolved (no
 * placeholders) and performs none of them: no filesystem writes outside a
 * throwaway temp dir it never creates, no spawn, no network.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UploadResponse } from '@bffless/artifact-client'
import { resolveRuleSet } from '@bffless/workflow-lint'
import JSZip from 'jszip'
import { readIdentity } from '../identity.js'
import { writeIndexBundle, type WriteResult } from '../index-bundle.js'
import { prepareRules } from '../prepare.js'

type Print = (line: string) => void

/**
 * The shape of move 3's spawn call, injectable so a test can simulate a
 * failing `rules push` (the exact live-proven case: a schema ref the server
 * rejects) without ever touching `npx`/the network — mirrors move 4's
 * `fetchImpl` injection (src/verbs/publish.ts's own `FetchImpl`) and
 * `runPublish`'s existing `env` parameter.
 */
export type SpawnRulesPush = (
  command: string,
  args: string[],
  options: { stdio: 'pipe'; env: NodeJS.ProcessEnv },
) => Buffer | string

export interface PublishArgs {
  apiUrl?: string
  project?: string
  alias?: string
  harnessAlias: string
  path: string
  workflows: string
  rules?: string
  dryRun: boolean
}

/** The pin other packages in this repo already spawn (test/rewrite.test.ts, hello-tree's package.json rules:validate). */
const BFFLESS_CLI_PIN = 'bffless@0.3.3'

/** publish-workflow action.yml's default `backend-url` — the CE backend's own address, as reachable from itself. */
const DEFAULT_BACKEND_URL = 'http://localhost:3000'

const VALUE_FLAGS = new Set(['--api-url', '--project', '--alias', '--harness-alias', '--path', '--workflows', '--rules'])

/** `--dry-run` aside, every flag takes a value; publish has no positional arguments. */
export function parsePublish(rest: string[]): PublishArgs | { error: string } {
  let dryRun = false
  const values: Record<string, string> = {}

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a === '--dry-run') {
      dryRun = true
    } else if (VALUE_FLAGS.has(a)) {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` }
      values[a] = value
    } else {
      return { error: `unknown option ${a}` }
    }
  }

  return {
    apiUrl: values['--api-url'],
    project: values['--project'],
    alias: values['--alias'],
    harnessAlias: values['--harness-alias'] ?? 'workflow',
    path: values['--path'] ?? 'dist',
    workflows: values['--workflows'] ?? '.bffless/workflows',
    rules: values['--rules'],
    dryRun,
  }
}

/** Strips a leading `./`, strips trailing `/`s — the bundle root the deployed alias serves from. */
function cleanRelPath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * The forwarder's target when no live per-alias domain exists: the alias
 * served in-process by the CE backend itself — mirrors publish-workflow
 * action.yml's "Resolve inputs" step default (`target-url` empty ->
 * `$BACKEND_URL/public/$REPOSITORY/alias/$ALIAS/$OUT`). No `--target-url`/
 * `--backend-url` flag exists on this verb (Decision 8's interface list
 * omits them) — `runPublish` always runs on the same host as the backend
 * it's publishing to, same assumption the action's default makes for CI.
 */
function resolveTargetUrl(project: string, alias: string, path: string): string {
  return `${DEFAULT_BACKEND_URL}/public/${project}/alias/${alias}/${cleanRelPath(path)}`
}

/** Splits `owner/name`; throws otherwise. Ported from publish-workflow's lib.mjs `splitRepository`. */
export function splitProject(project: string): [string, string] {
  const parts = project.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`--project "${project}" is not owner/name`)
  }
  return [parts[0], parts[1]]
}

/** A fetch-compatible function, injectable so tests can stub the network — same shape as attach.mjs's own `fetchImpl` option. */
export type FetchImpl = typeof fetch

/** Throws with the status + body on a non-2xx response; otherwise the parsed JSON body. Ported from publish-workflow's lib.mjs `request`. */
async function requestJson<T>(fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<T> {
  const res = await fetchImpl(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${res.status} ${res.statusText} ${body}`.trim())
  }
  return (await res.json()) as T
}

export interface ResolveRuleSetIdOptions {
  apiUrl: string
  apiKey: string
  project: string
  alias: string
  fetchImpl?: FetchImpl
}

/**
 * The just-synced rule set's id — needed for the harness attach (below),
 * which speaks in ids, never names. `rules push` (move 3) syncs by name and
 * prints only a human report (no `--json`, no id in its output), so this is
 * the same two-call name->id resolution the `bffless` CLI's own
 * `resolveProjectId` + rule-set list does internally
 * (packages/cli/src/api/resolve.ts in bffless/ce) — `--project` is always
 * `owner/name` here (Decision 8's interface), so only that form is handled.
 */
export async function resolveRuleSetId({ apiUrl, apiKey, project, alias, fetchImpl = fetch }: ResolveRuleSetIdOptions): Promise<string> {
  const [owner, name] = splitProject(project)
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' }
  const proj = await requestJson<{ id: string }>(
    fetchImpl,
    new URL(`/api/projects/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, apiUrl).toString(),
    { headers },
  )
  const list = await requestJson<{ ruleSets: { id: string; name: string }[] }>(
    fetchImpl,
    new URL(`/api/proxy-rule-sets/project/${proj.id}`, apiUrl).toString(),
    { headers },
  )
  const found = list.ruleSets.find((r) => r.name === alias)
  if (!found) throw new Error(`no rule set named "${alias}" found on project ${project} after \`rules push\``)
  return found.id
}

/** The join table is authoritative; fall back to the legacy scalar for a pre-0.2.0 row — ported from lib.mjs's `ruleSetIdsOf`. */
function ruleSetIdsOf(alias: { proxyRuleSetIds?: string[]; proxyRuleSetId?: string } | undefined): string[] {
  if (!alias) return []
  if (Array.isArray(alias.proxyRuleSetIds) && alias.proxyRuleSetIds.length > 0) return alias.proxyRuleSetIds
  return alias.proxyRuleSetId ? [alias.proxyRuleSetId] : []
}

/** Append `id` unless it is already present; order is the harness's rule precedence. Ported from publish-workflow's lib.mjs `unionIds`. */
export function unionIds(existing: string[] | undefined, id: string): string[] {
  const ids = Array.isArray(existing) ? [...existing] : []
  if (!ids.includes(id)) ids.push(id)
  return ids
}

export interface AttachToHarnessOptions {
  apiUrl: string
  apiKey: string
  project: string
  harnessAlias: string
  ruleSetId: string
  fetchImpl?: FetchImpl
}

/**
 * Union `ruleSetId` into the harness alias's own `proxyRuleSetIds` — ported
 * from publish-workflow's scripts/attach.mjs `attach()`. Idempotent:
 * publishing the same implementation twice PATCHes nothing the second time.
 */
export async function attachToHarness({
  apiUrl,
  apiKey,
  project,
  harnessAlias,
  ruleSetId,
  fetchImpl = fetch,
}: AttachToHarnessOptions): Promise<{ changed: boolean; proxyRuleSetIds: string[] }> {
  const [owner, name] = splitProject(project)
  const base = apiUrl.replace(/\/+$/, '')
  const headers = { 'X-API-Key': apiKey, Accept: 'application/json' }
  const listUrl = `${base}/api/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/aliases`

  const list = await requestJson<{ aliases?: { name: string; proxyRuleSetIds?: string[]; proxyRuleSetId?: string }[] }>(
    fetchImpl,
    listUrl,
    { headers },
  )
  const harnessRow = (list.aliases ?? []).find((a) => a.name === harnessAlias)
  if (!harnessRow) {
    const known = (list.aliases ?? []).map((a) => a.name).join(', ') || '(none)'
    throw new Error(
      `harness alias "${harnessAlias}" not found on ${project} — known aliases: ${known}. ` +
        'Create it (the harness deploy owns it) before publishing an implementation.',
    )
  }

  const before = ruleSetIdsOf(harnessRow)
  const proxyRuleSetIds = unionIds(before, ruleSetId)
  if (proxyRuleSetIds.length === before.length) return { changed: false, proxyRuleSetIds: before }

  await requestJson(fetchImpl, `${listUrl}/${encodeURIComponent(harnessAlias)}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxyRuleSetIds }),
  })
  return { changed: true, proxyRuleSetIds }
}

/** Every file under `root`, added to `zip` under `<prefix>/<rel>` — mirrors `archiver`'s `archive.directory(resolvedPath, buildPath)`. */
function addDirToZip(zip: JSZip, root: string, prefix: string): void {
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(full, entryRel)
      else if (entry.isFile()) zip.file(`${prefix}/${entryRel}`, readFileSync(full))
    }
  }
  walk(root, '')
}

export interface UploadBundleOptions {
  apiUrl: string
  apiKey: string
  project: string
  alias: string
  outPath: string
  path: string
  commitSha: string
  branch: string
  fetchImpl?: FetchImpl
}

/**
 * Zips `outPath` (the built bundle) under a `<path>/` prefix — same
 * "bundle root is `path` AS GIVEN, not its basename" rule
 * publish-workflow's action.yml documents at its "Resolve inputs" step — and
 * POSTs it multipart to `/api/deployments/zip`, `alias` + `basePath: '/'` +
 * `proxyRuleSetNames: [alias]` so the deployed alias serves the bundle at
 * `/` with its own rule set already attached (a second, independent thing
 * from the harness attach above, which unions the rule set into the
 * *harness* alias's own list).
 */
export async function uploadBundle({
  apiUrl,
  apiKey,
  project,
  alias,
  outPath,
  path,
  commitSha,
  branch,
  fetchImpl = fetch,
}: UploadBundleOptions): Promise<UploadResponse> {
  const zip = new JSZip()
  addDirToZip(zip, outPath, cleanRelPath(path))
  const buf = await zip.generateAsync({ type: 'nodebuffer' })

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buf)], { type: 'application/zip' }), 'bundle.zip')
  form.append('repository', project)
  form.append('commitSha', commitSha)
  form.append('branch', branch)
  form.append('isPublic', 'true')
  form.append('alias', alias)
  form.append('basePath', '/')
  form.append('proxyRuleSetNames', alias)

  const res = await fetchImpl(new URL('/api/deployments/zip', apiUrl), {
    method: 'POST',
    headers: { 'X-API-Key': apiKey },
    body: form,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || res.status !== 201) {
    throw new Error(`upload failed: HTTP ${res.status} ${JSON.stringify(body)}`)
  }
  return body as UploadResponse
}

/**
 * Runs `publish` rooted at `cwd` (same testability rationale as every other
 * verb: `dir` is a parameter, cli.ts passes `process.cwd()` for the real
 * invocation; `env` defaults to `process.env` but is overridable so a test
 * can assert the missing-key path without mutating the real environment).
 */
export async function runPublish(
  cwd: string,
  parsed: PublishArgs,
  out: Print,
  err: Print,
  env: NodeJS.ProcessEnv = process.env,
  spawnRulesPush: SpawnRulesPush = execFileSync,
): Promise<number> {
  let alias = parsed.alias
  if (!alias) {
    try {
      alias = readIdentity(cwd).alias
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }
  }

  const apiUrl = parsed.apiUrl ?? env.BFFLESS_API_URL
  if (!apiUrl) {
    err('workflow: --api-url or BFFLESS_API_URL is required')
    return 2
  }
  if (!parsed.project) {
    err('workflow: --project <owner/name> is required')
    return 2
  }
  const project = parsed.project

  const workflowsDir = resolve(cwd, parsed.workflows)
  const outPath = resolve(cwd, parsed.path)
  const rulesDir = parsed.rules ? resolve(cwd, parsed.rules) : join(cwd, '.bffless', 'proxy-rules', alias)
  const targetUrl = resolveTargetUrl(project, alias, parsed.path)
  const pathPrefix = `/api/${alias}`

  if (parsed.dryRun) {
    out(`workflow publish (dry run) — alias=${alias} harness-alias=${parsed.harnessAlias} project=${project} api-url=${apiUrl}`)
    out(`  1. index      ${workflowsDir} --out ${outPath} --impl ${alias} --rules ${rulesDir} --path-prefix ${pathPrefix}`)
    out(`  2. prepare    ${rulesDir} -> <tmp>/${alias} (rename ruleset.yaml name: to "${alias}"; forwarder /w/${alias}/* -> ${targetUrl})`)
    out(
      `  3. rules push npx --yes ${BFFLESS_CLI_PIN} rules push <prepared-dir> --path-prefix ${pathPrefix} --project ${project} --api-url ${apiUrl} --prune`,
    )
    out(
      `  4. upload     ${outPath} -> POST ${new URL('/api/deployments/zip', apiUrl).toString()} (alias=${alias}, base-path=/, proxyRuleSetNames=[${alias}]); ` +
        `then attach the synced rule set to harness alias "${parsed.harnessAlias}" on ${project}`,
    )
    out('(dry run) — nothing was written, no process was spawned, no network call was made')
    return 0
  }

  // Missing key exits 2 before any network call — every check above this
  // point is local (an identity-file read, string checks); nothing below
  // has run yet.
  const apiKey = env.BFFLESS_API_KEY
  if (!apiKey) {
    err('workflow: BFFLESS_API_KEY is required (environment only — never a flag)')
    return 2
  }

  // Move 1: index.
  if (!existsSync(workflowsDir)) {
    err(`workflow: no such directory: ${workflowsDir}`)
    return 2
  }
  const rules = resolveRuleSet({ file: join(workflowsDir, 'index.json'), rulesDir, alias, pathPrefix })
  if (!rules.found) {
    err(`workflow: ${rules.reason}`)
    return 2
  }
  let indexed: WriteResult
  try {
    indexed = writeIndexBundle({ workflowsDir, out: outPath, impl: alias, name: alias }, rules)
  } catch (e) {
    err(`workflow: ${(e as Error).message}`)
    return 2
  }
  if (!indexed.ok) {
    err(`workflow: ${indexed.findings.length} finding(s) — a failing lint is never published:`)
    for (const f of indexed.findings) {
      const pos = f.pos ? `${f.pos.line}:${f.pos.col}` : '-'
      err(`  ${f.file}  ${pos}  ${f.severity}  ${f.rule}  ${f.message}`)
    }
    return 1
  }
  out(`1. indexed ${indexed.workflowCount} workflow(s) → ${indexed.indexFile}`)

  // Move 2: prepare (alias-named copy + generated forwarder), staged under a
  // disposable temp dir disjoint from the source rule set.
  const stageRoot = mkdtempSync(join(tmpdir(), 'workflow-publish-'))
  const preparedDir = join(stageRoot, alias)
  try {
    try {
      prepareRules({ rulesDir, alias, targetUrl, outDir: preparedDir })
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }
    out(`2. prepared ${preparedDir} (rule set "${alias}" + /w/${alias}/* forwarder)`)

    // Move 3: rules push — spawn the published bffless CLI. The API key
    // never appears on the command line; it's inherited via `env`.
    try {
      spawnRulesPush(
        'npx',
        ['--yes', BFFLESS_CLI_PIN, 'rules', 'push', preparedDir, '--path-prefix', pathPrefix, '--project', project, '--api-url', apiUrl, '--prune'],
        { stdio: 'pipe', env: { ...env, BFFLESS_API_KEY: apiKey } },
      )
    } catch (e) {
      const exec = e as { stderr?: Buffer | string; stdout?: Buffer | string; message: string }
      const detail = exec.stderr?.toString().trim() || exec.stdout?.toString().trim() || exec.message
      err(`workflow: rules push failed: ${detail}`)
      return 2
    }
    out(`3. synced rule set "${alias}" to ${project}`)

    // Move 4: upload the bundle, then attach the synced rule set to the
    // harness alias's own union.
    let ruleSetId: string
    let upload: UploadResponse
    try {
      ruleSetId = await resolveRuleSetId({ apiUrl, apiKey, project, alias })
      upload = await uploadBundle({
        apiUrl,
        apiKey,
        project,
        alias,
        outPath,
        path: parsed.path,
        commitSha: env.GITHUB_SHA ?? 'unknown',
        branch: env.GITHUB_REF_NAME ?? 'unknown',
      })
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }
    out(`4. uploaded deployment ${upload.deploymentId} (${upload.fileCount} file(s), ${upload.totalSize} bytes)`)

    try {
      const attached = await attachToHarness({ apiUrl, apiKey, project, harnessAlias: parsed.harnessAlias, ruleSetId })
      out(
        attached.changed
          ? `   attached to harness "${parsed.harnessAlias}" → ${attached.proxyRuleSetIds.length} rule set(s)`
          : `   harness "${parsed.harnessAlias}" already carries the rule set — nothing to do`,
      )
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }

    out(`✔ published ${alias}`)
    return 0
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}
