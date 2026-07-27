#!/usr/bin/env node
// Dual-home repo-local skills into both harness directories.
//
// Three categories:
//  - vendored  (keys of skills-lock.json): fanned out by the `skills` CLI — in
//    `.claude/skills/` they are symlinks into `.agents/skills/`. Not our job here.
//  - published (canonical under plugins/bffless-apps/skills/): the public
//    collection third parties install (skills CLI / Claude plugin marketplace).
//    Mirrored into BOTH `.claude/skills/<name>/` and `.agents/skills/<name>/` as
//    real, byte-identical files so in-repo agents see them without the plugin.
//  - authored  (real dirs under `.claude/skills/`, not vendored, not published):
//    repo-private skills (e.g. install-app). Canonical in `.claude/skills/`,
//    mirrored into `.agents/skills/<name>/`.
//
//   node scripts/sync-skills.mjs          # write the mirror copies
//   node scripts/sync-skills.mjs --check  # verify parity, exit 1 on drift
//
// The sets are derived, not hard-coded: drop a skill directory into
// `plugins/bffless-apps/skills/` (published) or `.claude/skills/` (authored)
// and it is picked up here.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE_DIR = path.join(repoRoot, '.claude', 'skills')
const AGENTS_DIR = path.join(repoRoot, '.agents', 'skills')
const PLUGIN_DIR = path.join(repoRoot, 'plugins', 'bffless-apps', 'skills')
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

// Published skills = directories under plugins/bffless-apps/skills/. A name
// that collides with a vendored skill (a skills-lock.json key) would silently
// clobber vendored content when mirrored below, so fail loudly instead.
async function publishedSkills() {
  let entries
  try {
    entries = await fs.readdir(PLUGIN_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  const vendored = await vendoredSkillNames()
  const collisions = names.filter((name) => vendored.has(name))
  if (collisions.length > 0) {
    console.error(
      `skill name collision: ${collisions.join(', ')} ${collisions.length === 1 ? 'is' : 'are'} both ` +
        'published (plugins/bffless-apps/skills/) and vendored (skills-lock.json) — ' +
        'mirroring would clobber the vendored copy. Rename one side.',
    )
    process.exit(1)
  }
  return names
}

// Authored skills = real dirs under .claude/skills not vendored and not published
// (published mirrors land in .claude/skills too — the plugin copy is canonical).
async function authoredSkills(published) {
  const vendored = await vendoredSkillNames()
  const publishedSet = new Set(published)
  const entries = await fs.readdir(CLAUDE_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !vendored.has(e.name) && !publishedSet.has(e.name))
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

// Mirror one skill from its canonical `src` dir into each of `dstDirs`
// (byte-identical real files; in write mode removals propagate).
async function mirrorSkill(name, src, dstDirs) {
  const srcFiles = await listFiles(src)
  const srcLabel = path.relative(repoRoot, src)

  for (const dst of dstDirs) {
    const dstLabel = path.relative(repoRoot, dst)

    if (check) {
      if (!(await exists(dst))) {
        drift.push(`missing: ${dstLabel} (canonical exists in ${srcLabel})`)
        continue
      }
      const dstFiles = await listFiles(dst)
      const srcSet = new Set(srcFiles)
      const dstSet = new Set(dstFiles)
      for (const f of dstFiles) {
        if (!srcSet.has(f)) drift.push(`extra:   ${dstLabel}/${f} (not in canonical ${srcLabel})`)
      }
      for (const f of srcFiles) {
        if (!dstSet.has(f)) {
          drift.push(`missing: ${dstLabel}/${f}`)
          continue
        }
        const a = await fs.readFile(path.join(src, f))
        const b = await fs.readFile(path.join(dst, f))
        if (!a.equals(b)) drift.push(`differs: ${dstLabel}/${f} (canonical: ${srcLabel})`)
      }
      continue
    }

    // Write mode: mirror canonical → dst (fresh, so removals propagate).
    await fs.rm(dst, { recursive: true, force: true })
    for (const f of srcFiles) {
      const to = path.join(dst, f)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(path.join(src, f), to)
    }
    console.log(`synced ${name}: ${srcFiles.length} file(s) → ${dstLabel}/`)
  }
}

const published = await publishedSkills()
const authored = await authoredSkills(published)
if (published.length + authored.length === 0) {
  console.error('no published or authored skills found')
  process.exit(1)
}

for (const name of published) {
  await mirrorSkill(name, path.join(PLUGIN_DIR, name), [path.join(CLAUDE_DIR, name), path.join(AGENTS_DIR, name)])
}
for (const name of authored) {
  await mirrorSkill(name, path.join(CLAUDE_DIR, name), [path.join(AGENTS_DIR, name)])
}

if (check) {
  if (drift.length > 0) {
    console.error('skills parity check FAILED — mirror copies drifted from canonical:')
    for (const d of drift) console.error('  ' + d)
    console.error('\nRun `pnpm skills:sync` and commit the result.')
    process.exit(1)
  }
  console.log(`skills parity OK (published: ${published.join(', ') || 'none'}; authored: ${authored.join(', ') || 'none'})`)
}
