#!/usr/bin/env node
// Resolves the commit whose tree produced a bundle. Kept separate from build-app-bundle.mjs so
// it carries no dependencies and can be unit-tested (scripts/source-commit.test.mjs) without
// a pnpm install.
//
// Build time is the only point where this is unambiguous — the builder zips the tree it is
// standing in. Doing it later, from a workflow's ${{ github.sha }}, is wrong for any run that
// did not build the bundle it is stamping: deploy-store.yml republishes registry.json on
// store/catalog edits without building anything, where github.sha is main's HEAD and belongs to
// none of the entries.

import { spawnSync } from 'node:child_process'

const SHA_PATTERN = /^[0-9a-f]{40}$/i

/**
 * @param {string} cwd repo checkout to inspect
 * @returns {string|null} lowercase 40-hex sha, or null when not knowable
 */
export function resolveSourceCommit(cwd) {
  // In CI, GITHUB_SHA is by definition the commit actions/checkout checked out, for every
  // trigger this repo uses (tag push, workflow_dispatch, pull_request). No round-trip, and
  // nothing external to fail.
  const fromCi = process.env.GITHUB_SHA
  if (fromCi && SHA_PATTERN.test(fromCi.trim())) return fromCi.trim().toLowerCase()

  // Locally, HEAD — but only on a clean tree. A bundle built over uncommitted changes did not
  // come from any commit, and a plausible-but-wrong commit is worse than none: it would point
  // CE's References panel at source that never produced those bytes. Every unresolvable case
  // returns null, which degrades honestly downstream (CE falls back to the bundle hash,
  // registry.json omits the field).
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
  if (status.status !== 0) {
    console.log('source-commit: not a git checkout — omitting the source commit')
    return null
  }
  if (status.stdout.trim() !== '') {
    console.log('source-commit: working tree is dirty — omitting the source commit')
    return null
  }

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
  const sha = head.status === 0 ? head.stdout.trim() : ''
  if (!SHA_PATTERN.test(sha)) {
    console.log('source-commit: could not resolve HEAD — omitting the source commit')
    return null
  }
  return sha.toLowerCase()
}
