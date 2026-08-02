import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveSourceCommit } from './source-commit.mjs'

// Source-commit resolution decides what CE stamps as an install's commitSha, so its failure
// mode matters more than its happy path: it must return null (never a guess) whenever the
// commit behind the bytes is not knowable. These run against real throwaway git repos rather
// than mocks, because the behaviour under test IS git's.

const originalSha = process.env.GITHUB_SHA
afterEach(() => {
  if (originalSha === undefined) delete process.env.GITHUB_SHA
  else process.env.GITHUB_SHA = originalSha
})

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

// A repo with one commit; `dirty` leaves an uncommitted tracked-file edit behind.
function makeRepo({ dirty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'build-app-bundle-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'file.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  const head = git(dir, 'rev-parse', 'HEAD')
  if (dirty) writeFileSync(join(dir, 'file.txt'), 'two\n')
  return { dir, head }
}

test('resolves HEAD on a clean checkout', () => {
  delete process.env.GITHUB_SHA
  const { dir, head } = makeRepo()
  assert.equal(resolveSourceCommit(dir), head)
})

// The core safety rule: bytes built over uncommitted changes came from no commit at all, so
// attributing them to HEAD would point CE's References panel at source that never built them.
test('returns null on a dirty tree rather than attributing to HEAD', () => {
  delete process.env.GITHUB_SHA
  const { dir } = makeRepo({ dirty: true })
  assert.equal(resolveSourceCommit(dir), null)
})

test('returns null outside a git checkout', () => {
  delete process.env.GITHUB_SHA
  const dir = mkdtempSync(join(tmpdir(), 'build-app-bundle-nogit-'))
  assert.equal(resolveSourceCommit(dir), null)
})

// In CI the checked-out commit is authoritative and needs no git round-trip — and it must win
// even where the working tree has picked up untracked build output.
test('prefers GITHUB_SHA, and does not consult the tree', () => {
  const sha = 'c01bb08a1b2c3d4e5f60718293a4b5c6d7e8f900'
  process.env.GITHUB_SHA = sha.toUpperCase()
  const { dir } = makeRepo({ dirty: true })
  assert.equal(resolveSourceCommit(dir), sha, 'expected the CI sha, normalised to lowercase')
})

test('ignores a malformed GITHUB_SHA and falls back to the tree', () => {
  process.env.GITHUB_SHA = 'not-a-sha'
  const { dir, head } = makeRepo()
  assert.equal(resolveSourceCommit(dir), head)
})
