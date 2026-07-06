#!/usr/bin/env node
/**
 * Fix #4 — make the singleton root marker R non-deletable.
 *
 * The DELETE /api/node gate blocks deletion of a folder that still has children
 * (`var guardBlocked=isFolder&&hasChildren;`), where `isFolder=nodeType==='folder'`.
 * R has `nodeType:'root'`, not 'folder', so it slipped past the guard — an admin
 * who knows R's UUID could delete it, orphaning every grant/link scoped to root
 * (R would then lazily re-create as an empty record). This widens the guard to
 * also block `nodeType==='root'`, so R can never be deleted.
 *
 * Idempotent: no-op once the widened guard is present. The exact source
 * `var guardBlocked=isFolder&&hasChildren;` occurs EXACTLY 1× (the delete gate).
 *
 * Writes back with `JSON.stringify(doc, null, 2) + '\n'` (the file's canonical
 * form) so the diff stays localized. Run from the app dir:
 *   node bffless/scripts/patch-guard-root.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const jsonUrl = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(jsonUrl, 'utf8'))

const OLD = 'var guardBlocked=isFolder&&hasChildren;'
const NEW = "var guardBlocked=(isFolder&&hasChildren)||nodeType==='root';"

let guards = 0

for (const rule of doc.rules) {
  const steps = (rule.pipelineConfig && rule.pipelineConfig.steps) || []
  for (const s of steps) {
    const code = s.config && s.config.code
    if (typeof code !== 'string' || !code.includes(OLD)) continue
    if (code.includes(NEW)) continue // already patched (idempotent)
    s.config.code = code.replace(OLD, NEW)
    guards++
  }
}

writeFileSync(jsonUrl, JSON.stringify(doc, null, 2) + '\n')
console.log(`delete guards widened (nodeType root non-deletable): ${guards}`)
