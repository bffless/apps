/**
 * The network business logic behind `workflow publish`'s moves 3-4
 * (src/verbs/publish.ts): `attachToHarness` (a port of
 * `bffless/publish-workflow` `scripts/attach.mjs`'s `attach()`),
 * `resolveRuleSetId` (the name->id resolution `attach.mjs` doesn't need —
 * its CLI wrapper is handed an id directly — but this port does, since
 * spawning the raw `bffless` CLI for `rules push` per Decision 8 gets us no
 * id back), and `uploadBundle` (the multipart zip deploy).
 *
 * All three take an injectable `fetchImpl` (default `fetch`), mirroring
 * `attach.mjs`'s own `fetchImpl = fetch` option — the same pattern
 * `test/prepare.test.ts` follows for the filesystem side of `publish`, kept
 * entirely offline here via a stubbed `fetch`. Cases 1-8 below are ported
 * from `bffless/publish-workflow` `test/attach.test.mjs` (fetched read-only,
 * not re-typed from memory); case 3 in that file ("attach unions every id in
 * a comma-separated list") has no counterpart — `attach.mjs`'s CLI wrapper
 * accepts a comma-separated `--rule-set-id` and splits it before calling
 * `attach()`, but `resolveRuleSetId` here only ever resolves exactly one id,
 * so `attachToHarness`'s `ruleSetId` is a single string, not a list.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  attachToHarness,
  resolveCommitSha,
  resolveRuleSetId,
  splitProject,
  unionIds,
  uploadBundle,
  type FetchImpl,
} from '../src/verbs/publish.js'

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('splitProject', () => {
  test('splits owner/name', () => {
    expect(splitProject('acme/site')).toEqual(['acme', 'site'])
  })

  test('rejects anything that is not owner/name', () => {
    for (const bad of ['justname', 'a/b/c', '/name', 'owner/']) {
      expect(() => splitProject(bad)).toThrow(/owner\/name/)
    }
  })
})

/** A fresh, disposable, never-`git init`ed temp dir — outside any git repo. */
function nonGitTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'workflow-cli-sha-'))
}

/** A temp dir, `git init`ed with one commit — a real, resolvable `git rev-parse HEAD`. No global gitconfig touched (inline `-c` identity). */
function gitTempDirWithCommit(): string {
  const dir = nonGitTempDir()
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'file.txt'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'initial'],
    { cwd: dir, stdio: 'pipe' },
  )
  return dir
}

describe('resolveCommitSha', () => {
  // apps#420 j5s live smoke, round 2: `workflow publish` ran in a fresh
  // `init` output before any git init/commit — a normal authoring state —
  // and CE's `CreateDeploymentZipDto.commitSha` validator
  // (@Matches(/^[a-f0-9]{7,40}$/i) — read directly from
  // apps/backend/src/deployments/deployments.dto.ts in bffless/ce, not
  // assumed) rejected whatever was sent. Both branches below are checked
  // against that exact regex, not a re-derived approximation of it.
  const CE_COMMIT_SHA_RE = /^[a-f0-9]{7,40}$/i

  test('resolves `git rev-parse HEAD` when cwd is inside a git repo with at least one commit', () => {
    const dir = gitTempDirWithCommit()
    const expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

    const sha = resolveCommitSha(dir)
    expect(sha).toBe(expected)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    expect(sha).toMatch(CE_COMMIT_SHA_RE)
  })

  test('falls back to the format-valid all-zero placeholder outside a git repo', () => {
    const sha = resolveCommitSha(nonGitTempDir())
    expect(sha).toBe('0'.repeat(40))
    expect(sha).toMatch(CE_COMMIT_SHA_RE)
  })

  test('falls back to the placeholder inside a git repo with zero commits (a fresh `git init`, nothing committed yet)', () => {
    const dir = nonGitTempDir()
    execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'pipe' })
    expect(resolveCommitSha(dir)).toBe('0'.repeat(40))
  })
})

describe('unionIds', () => {
  // Ported verbatim (case names + assertions) from attach.mjs's own `unionIds` tests.
  test('appends once, in order', () => {
    expect(unionIds(['a', 'b'], 'b')).toEqual(['a', 'b'])
    expect(unionIds(['a'], 'c')).toEqual(['a', 'c'])
    expect(unionIds([], 'c')).toEqual(['c'])
    expect(unionIds(undefined, 'c')).toEqual(['c'])
  })
})

/** A CE stub: GET .../aliases lists, PATCH .../aliases/<name> accepts — same shape as attach.test.mjs's own `stub()`. */
function stubAliases(
  aliases: { name: string; proxyRuleSetIds?: string[]; proxyRuleSetId?: string }[],
  { patchStatus = 200, patchBody = {} }: { patchStatus?: number; patchBody?: unknown } = {},
): { calls: [string, string, unknown, unknown][]; fetchImpl: FetchImpl } {
  const calls: [string, string, unknown, unknown][] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push([String(url), method, init?.body, init?.headers])
    if (method === 'GET') return jsonResponse({ repository: 'o/n', aliases })
    return jsonResponse(patchBody, patchStatus)
  }) as FetchImpl
  return { calls, fetchImpl }
}

describe('attachToHarness', () => {
  // Ported from attach.test.mjs: "attach GETs the repo aliases then PATCHes the union".
  test('GETs the project aliases then PATCHes the union', async () => {
    const { calls, fetchImpl } = stubAliases([{ name: 'workflow', proxyRuleSetIds: ['a'] }])
    const result = await attachToHarness({
      apiUrl: 'https://x',
      apiKey: 'k',
      project: 'o/n',
      harnessAlias: 'workflow',
      ruleSetId: 'b',
      fetchImpl,
    })
    expect(result).toEqual({ changed: true, proxyRuleSetIds: ['a', 'b'] })
    expect(calls[0]?.[0]).toBe('https://x/api/repo/o/n/aliases')
    expect(calls[0]?.[1]).toBe('GET')
    expect((calls[0]?.[3] as Record<string, string>)['X-API-Key']).toBe('k')
    expect(calls[1]?.[0]).toBe('https://x/api/repo/o/n/aliases/workflow')
    expect(calls[1]?.[1]).toBe('PATCH')
    expect(JSON.parse(calls[1]?.[2] as string)).toEqual({ proxyRuleSetIds: ['a', 'b'] })
  })

  // Ported from attach.test.mjs: "attach falls back to the legacy single proxyRuleSetId".
  test('falls back to the legacy single proxyRuleSetId', async () => {
    const { calls, fetchImpl } = stubAliases([{ name: 'workflow', proxyRuleSetId: 'a' }])
    await attachToHarness({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl })
    expect(JSON.parse(calls[1]?.[2] as string)).toEqual({ proxyRuleSetIds: ['a', 'b'] })
  })

  // Ported from attach.test.mjs: "attach is a no-op PATCH-free when the set is already attached".
  test('is idempotent — a no-op, no PATCH, when the set is already attached', async () => {
    const { calls, fetchImpl } = stubAliases([{ name: 'workflow', proxyRuleSetIds: ['a', 'b'] }])
    const result = await attachToHarness({
      apiUrl: 'https://x',
      apiKey: 'k',
      project: 'o/n',
      harnessAlias: 'workflow',
      ruleSetId: 'b',
      fetchImpl,
    })
    expect(calls.length).toBe(1) // GET only — no PATCH call at all.
    expect(result).toEqual({ changed: false, proxyRuleSetIds: ['a', 'b'] })
  })

  // Ported from attach.test.mjs: "attach fails when the harness alias does not exist".
  test('throws naming the harness alias when it does not exist on the project', async () => {
    const { fetchImpl } = stubAliases([{ name: 'production', proxyRuleSetIds: [] }])
    await expect(
      attachToHarness({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    ).rejects.toThrow(/harness alias "workflow" not found/)
  })

  // Ported from attach.test.mjs: "attach throws with the status and body on a non-2xx".
  test('throws with the status and body on a non-2xx', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as FetchImpl
    await expect(
      attachToHarness({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    ).rejects.toThrow(/403.*nope/s)
  })

  // Ported from attach.test.mjs: "attach rejects a repository that is not owner/name" (repository -> --project here).
  test('rejects a malformed --project before any fetch call', async () => {
    const { calls, fetchImpl } = stubAliases([])
    await expect(
      attachToHarness({ apiUrl: 'https://x', apiKey: 'k', project: 'justname', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    ).rejects.toThrow(/owner\/name/)
    expect(calls.length).toBe(0)
  })

  // A non-2xx PATCH (distinct from the GET-side non-2xx above) surfaces the same way.
  test('throws with the status and body on a non-2xx PATCH', async () => {
    const { fetchImpl } = stubAliases([{ name: 'workflow', proxyRuleSetIds: ['a'] }], { patchStatus: 500, patchBody: 'db down' })
    await expect(
      attachToHarness({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', harnessAlias: 'workflow', ruleSetId: 'b', fetchImpl }),
    ).rejects.toThrow(/500/)
  })
})

/** A CE stub for the project + rule-set-list GETs `resolveRuleSetId` makes, in order. */
function stubProjectAndRuleSets(opts: {
  projectStatus?: number
  projectBody?: unknown
  listStatus?: number
  listBody?: unknown
}): { calls: string[]; fetchImpl: FetchImpl } {
  const { projectStatus = 200, projectBody = { id: 'proj-1' }, listStatus = 200, listBody = { ruleSets: [{ id: 'rs-1', name: 'hello' }] } } =
    opts
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('/api/projects/')) return jsonResponse(projectBody, projectStatus)
    return jsonResponse(listBody, listStatus)
  }) as FetchImpl
  return { calls, fetchImpl }
}

describe('resolveRuleSetId', () => {
  test('resolves the project then finds the rule set by name', async () => {
    const { calls, fetchImpl } = stubProjectAndRuleSets({})
    const id = await resolveRuleSetId({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', alias: 'hello', fetchImpl })
    expect(id).toBe('rs-1')
    expect(calls[0]).toBe('https://x/api/projects/o/n')
    expect(calls[1]).toBe('https://x/api/proxy-rule-sets/project/proj-1')
  })

  test('throws when no rule set named <alias> exists after `rules push`', async () => {
    const { fetchImpl } = stubProjectAndRuleSets({ listBody: { ruleSets: [{ id: 'rs-1', name: 'someone-else' }] } })
    await expect(resolveRuleSetId({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', alias: 'hello', fetchImpl })).rejects.toThrow(
      /no rule set named "hello".*after `rules push`/,
    )
  })

  test('throws with the status and body on a non-2xx project lookup', async () => {
    const { fetchImpl } = stubProjectAndRuleSets({ projectStatus: 404, projectBody: 'project not found' })
    await expect(resolveRuleSetId({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', alias: 'hello', fetchImpl })).rejects.toThrow(
      /404/,
    )
  })

  test('throws with the status and body on a non-2xx rule-set list', async () => {
    const { fetchImpl } = stubProjectAndRuleSets({ listStatus: 500, listBody: 'boom' })
    await expect(resolveRuleSetId({ apiUrl: 'https://x', apiKey: 'k', project: 'o/n', alias: 'hello', fetchImpl })).rejects.toThrow(
      /500/,
    )
  })

  test('rejects a malformed --project before any fetch call', async () => {
    const { calls, fetchImpl } = stubProjectAndRuleSets({})
    await expect(resolveRuleSetId({ apiUrl: 'https://x', apiKey: 'k', project: 'justname', alias: 'hello', fetchImpl })).rejects.toThrow(
      /owner\/name/,
    )
    expect(calls.length).toBe(0)
  })
})

/** A small dir with two files, to zip. */
function tinyBundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-cli-upload-'))
  writeFileSync(join(dir, 'index.html'), '<html></html>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
  return dir
}

describe('uploadBundle', () => {
  test('zips the bundle and POSTs the expected multipart fields', async () => {
    const outPath = tinyBundleDir()
    let seenUrl: string | undefined
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url)
      seenInit = init
      return jsonResponse({ deploymentId: 'd1', fileCount: 2, totalSize: 42, urls: {} }, 201)
    }) as FetchImpl

    const result = await uploadBundle({
      apiUrl: 'https://x',
      apiKey: 'k',
      project: 'o/n',
      alias: 'hello',
      outPath,
      path: 'dist',
      commitSha: 'abc123',
      branch: 'main',
      fetchImpl,
    })

    expect(result).toEqual({ deploymentId: 'd1', fileCount: 2, totalSize: 42, urls: {} })
    expect(seenUrl).toBe('https://x/api/deployments/zip')
    expect(seenInit?.method).toBe('POST')
    expect((seenInit?.headers as Record<string, string>)['X-API-Key']).toBe('k')

    const form = seenInit?.body as FormData
    expect(form.get('repository')).toBe('o/n')
    expect(form.get('commitSha')).toBe('abc123')
    expect(form.get('branch')).toBe('main')
    expect(form.get('isPublic')).toBe('true')
    expect(form.get('alias')).toBe('hello')
    expect(form.get('basePath')).toBe('/')
    expect(form.get('proxyRuleSetNames')).toBe('hello')
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.name).toBe('bundle.zip')
  })

  test('throws with the status and body on a non-2xx (and a 200 that is not 201)', async () => {
    const outPath = tinyBundleDir()
    const failing = (async () => jsonResponse({ message: 'boom' }, 500)) as FetchImpl
    await expect(
      uploadBundle({
        apiUrl: 'https://x',
        apiKey: 'k',
        project: 'o/n',
        alias: 'hello',
        outPath,
        path: 'dist',
        commitSha: 'abc123',
        branch: 'main',
        fetchImpl: failing,
      }),
    ).rejects.toThrow(/500.*boom/s)

    // A 200 (res.ok) that isn't 201 is still an error — the deployments/zip
    // endpoint's only success status is 201.
    const notCreated = (async () => jsonResponse({ deploymentId: 'd1' }, 200)) as FetchImpl
    await expect(
      uploadBundle({
        apiUrl: 'https://x',
        apiKey: 'k',
        project: 'o/n',
        alias: 'hello',
        outPath,
        path: 'dist',
        commitSha: 'abc123',
        branch: 'main',
        fetchImpl: notCreated,
      }),
    ).rejects.toThrow(/upload failed: HTTP 200/)
  })
})
