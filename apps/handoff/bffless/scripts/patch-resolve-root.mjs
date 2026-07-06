#!/usr/bin/env node
/**
 * Splice the resolve-root group into Handoff's mint & grants pipelines so the
 * synthetic 'root' folderId resolves to the singleton root record's UUID, and
 * gate root creation/sharing to admins only.
 *
 * Idempotent: if a target rule already contains `resolveRootShape` the group is
 * not re-spliced. Field edits set exact values, so they are safe to re-apply.
 *
 * The proxy-rules JSON is written back with `JSON.stringify(doc, null, 2) + '\n'`,
 * the same canonical format the file is already in, so a patched file diffs only
 * on the five touched rules. Run: `node bffless/scripts/patch-resolve-root.mjs`
 * from the app dir (or `node apps/handoff/bffless/scripts/patch-resolve-root.mjs`).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const jsonUrl = new URL('../handoff.proxy-rules.json', import.meta.url)
const fragUrl = new URL('../_fragments/resolve-root.json', import.meta.url)

const doc = JSON.parse(readFileSync(jsonUrl, 'utf8'))
const fragment = JSON.parse(readFileSync(fragUrl, 'utf8'))

const EFFECTIVE = 'steps.resolveRootShape.effectiveFolderId'

// Write group = full fragment (incl. rootCreate). Read group drops rootCreate.
const writeGroup = fragment
const readGroup = fragment.filter((s) => s.id !== 'rootCreate')

function getRule(method, pathPattern) {
  const r = doc.rules.find((x) => x.method === method && x.pathPattern === pathPattern)
  if (!r) throw new Error(`rule not found: ${method} ${pathPattern}`)
  if (!r.pipelineConfig || !Array.isArray(r.pipelineConfig.steps)) {
    throw new Error(`rule has no pipelineConfig.steps: ${method} ${pathPattern}`)
  }
  return r
}

function getStep(rule, id) {
  const s = rule.pipelineConfig.steps.find((x) => x.id === id)
  if (!s) throw new Error(`step not found: ${id} in ${rule.method} ${rule.pathPattern}`)
  return s
}

// Splice `group` immediately before the step `beforeId`. Idempotent: no-op if
// the group is already present (detected via resolveRootShape).
function spliceGroup(rule, beforeId, group) {
  const steps = rule.pipelineConfig.steps
  if (steps.some((s) => s.id === 'resolveRootShape')) return
  const idx = steps.findIndex((s) => s.id === beforeId)
  if (idx < 0) throw new Error(`splice anchor not found: ${beforeId} in ${rule.pathPattern}`)
  const clone = JSON.parse(JSON.stringify(group))
  steps.splice(idx, 0, ...clone)
}

// --- POST /api/share-links (mint): full write group before `folder` ----------
{
  const r = getRule('POST', '/api/share-links')
  spliceGroup(r, 'folder', writeGroup)
  const folder = getStep(r, 'folder')
  folder.config.recordId = EFFECTIVE
  folder.config.condition = EFFECTIVE
  getStep(r, 'create').config.fields.folderId = EFFECTIVE
}

// --- POST /api/grants: full write group before `folder` ----------------------
{
  const r = getRule('POST', '/api/grants')
  spliceGroup(r, 'folder', writeGroup)
  const folder = getStep(r, 'folder')
  folder.config.recordId = EFFECTIVE
  folder.config.condition = EFFECTIVE
  // save keeps its existing `condition: steps.merge.allowed`.
  getStep(r, 'save').config.recordId = EFFECTIVE
}

// --- GET /api/grants: read-only group before `folder` ------------------------
{
  const r = getRule('GET', '/api/grants')
  spliceGroup(r, 'folder', readGroup)
  const folder = getStep(r, 'folder')
  folder.config.recordId = EFFECTIVE
  folder.config.condition = EFFECTIVE
}

// --- GET /api/share-links: read-only group before `rows` ---------------------
{
  const r = getRule('GET', '/api/share-links')
  spliceGroup(r, 'rows', readGroup)
  const rows = getStep(r, 'rows')
  rows.config.filters.folderId.value = EFFECTIVE
  rows.config.condition = EFFECTIVE
}

// --- POST /api/grants/revoke: read-only group before `folder` ----------------
{
  const r = getRule('POST', '/api/grants/revoke')
  spliceGroup(r, 'folder', readGroup)
  const folder = getStep(r, 'folder')
  folder.config.recordId = EFFECTIVE
  folder.config.condition = EFFECTIVE
  // save keeps its existing `condition: steps.merge.allowed`.
  getStep(r, 'save').config.recordId = EFFECTIVE
}

writeFileSync(jsonUrl, JSON.stringify(doc, null, 2) + '\n')
console.log('patched handoff.proxy-rules.json (resolve-root spliced into mint & grants)')
