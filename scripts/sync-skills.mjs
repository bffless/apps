#!/usr/bin/env node
// Dual-home repo-local *authored* skills into both harness directories.
//
// Vendored skills (tracked in skills-lock.json) are fanned out by the `skills`
// CLI — in `.claude/skills/` they are symlinks into `.agents/skills/`. Authored
// skills (NOT in the lock: e.g. `install-app`, `handoff-api`) have no such
// tooling, so a symlink would be fragile across checkouts/Windows. Instead we
// keep the canonical copy under `.claude/skills/<name>/` and mirror it into
// `.agents/skills/<name>/` as real, byte-identical files — whatever is committed
// is what a fork gets, in both harness layouts.
//
//   node scripts/sync-skills.mjs          # write the `.agents` copies
//   node scripts/sync-skills.mjs --check  # verify parity, exit 1 on drift
//
// The set of authored skills is derived, not hard-coded: any real (non-symlink)
// directory under `.claude/skills/` whose name is not a key in skills-lock.json.
// Drop a new authored skill in `.claude/skills/` and it is picked up here.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE_DIR = path.join(repoRoot, '.claude', 'skills')
const AGENTS_DIR = path.join(repoRoot, '.agents', 'skills')
const LOCK_FILE = path.join(repoRoot, 'skills-lock.json')

const check = process.argv.includes('--check')

async function vendoredSkillNames() {
  try {
    const lock = JSON.parse(await fs.readFile(LOCK_FILE, 'utf8'))
    return new Set(Object.keys(lock.skills ?? {}))
  } catch {
    return new Set()
  }
}

// Authored skills = real dirs under .claude/skills not in the lock (and not symlinks).
async function authoredSkills() {
  const vendored = await vendoredSkillNames()
  const entries = await fs.readdir(CLAUDE_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !vendored.has(e.name))
    .map((e) => e.name)
    .sort()
}

// Recursively list files (repo-relative to `dir`) so we can compare/copy trees.
async function listFiles(dir) {
  const out = []
  async function walk(rel) {
    const abs = path.join(dir, rel)
    const entries = await fs.readdir(abs, { withFileTypes: true })
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = path.join(rel, e.name)
      if (e.isDirectory()) await walk(childRel)
      else out.push(childRel)
    }
  }
  await walk('')
  return out.sort()
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

const drift = []

async function syncSkill(name) {
  const src = path.join(CLAUDE_DIR, name)
  const dst = path.join(AGENTS_DIR, name)
  const srcFiles = await listFiles(src)

  if (check) {
    if (!(await exists(dst))) {
      drift.push(`missing: .agents/skills/${name} (canonical exists in .claude/skills)`)
      return
    }
    const dstFiles = await listFiles(dst)
    const srcSet = new Set(srcFiles)
    const dstSet = new Set(dstFiles)
    for (const f of dstFiles) {
      if (!srcSet.has(f)) drift.push(`extra:   .agents/skills/${name}/${f} (not in canonical)`)
    }
    for (const f of srcFiles) {
      if (!dstSet.has(f)) {
        drift.push(`missing: .agents/skills/${name}/${f}`)
        continue
      }
      const a = await fs.readFile(path.join(src, f))
      const b = await fs.readFile(path.join(dst, f))
      if (!a.equals(b)) drift.push(`differs: ${name}/${f}`)
    }
    return
  }

  // Write mode: mirror canonical → .agents (fresh, so removals propagate).
  await fs.rm(dst, { recursive: true, force: true })
  for (const f of srcFiles) {
    const to = path.join(dst, f)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.copyFile(path.join(src, f), to)
  }
  console.log(`synced ${name}: ${srcFiles.length} file(s) → .agents/skills/${name}/`)
}

const names = await authoredSkills()
if (names.length === 0) {
  console.error('no authored skills found under .claude/skills/')
  process.exit(1)
}
for (const name of names) await syncSkill(name)

if (check) {
  if (drift.length > 0) {
    console.error('skills parity check FAILED — .claude and .agents copies drifted:')
    for (const d of drift) console.error('  ' + d)
    console.error('\nRun `pnpm skills:sync` and commit the result.')
    process.exit(1)
  }
  console.log(`skills parity OK (${names.join(', ')})`)
}
