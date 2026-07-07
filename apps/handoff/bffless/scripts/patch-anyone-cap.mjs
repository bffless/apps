// Inserts the Anyone view-cap into the POST /api/grants merge step (ADR-0005).
import { readFileSync, writeFileSync } from 'node:fs'

const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))

const rule = doc.rules.find((r) => r.pathPattern === '/api/grants' && r.method === 'POST')
const step = rule.pipelineConfig.steps.find((s) => s.id === 'merge')

const ANCHOR = 'var email = body.principalEmail ? String(body.principalEmail) : null;'
const CAP = "\n  if (pid === 'anyone') { level = 'view'; email = null; }"

const REPLACE_ANCHOR =
  "out.push({ principalId: pid, principalEmail: email || g.principalEmail || null, level: level });"
const REPLACE_FIX =
  "out.push({ principalId: pid, principalEmail: (pid === 'anyone') ? null : (email || g.principalEmail || null), level: level });"

let changed = false

if (step.config.code.includes("pid === 'anyone'")) {
  console.log('cap already present — nothing to do')
} else {
  if (!step.config.code.includes(ANCHOR)) {
    console.error('anchor line not found in merge step — inspect the step body')
    process.exit(1)
  }
  step.config.code = step.config.code.replace(ANCHOR, ANCHOR + CAP)
  changed = true
  console.log('anyone view-cap inserted into grants merge')
}

if (step.config.code.includes(REPLACE_FIX)) {
  console.log('replace-branch email fix already present — nothing to do')
} else {
  if (!step.config.code.includes(REPLACE_ANCHOR)) {
    console.error('replace-branch anchor not found in merge step — inspect the step body')
    process.exit(1)
  }
  step.config.code = step.config.code.replace(REPLACE_ANCHOR, REPLACE_FIX)
  changed = true
  console.log('replace-branch email fix inserted into grants merge (stale principalEmail no longer leaks for anyone)')
}

if (changed) {
  writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
} else {
  console.log('nothing to do — both patches already present')
}
