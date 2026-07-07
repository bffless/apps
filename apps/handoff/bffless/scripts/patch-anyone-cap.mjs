// Inserts the Anyone view-cap into the POST /api/grants merge step (ADR-0005).
import { readFileSync, writeFileSync } from 'node:fs'

const P = new URL('../handoff.proxy-rules.json', import.meta.url)
const doc = JSON.parse(readFileSync(P, 'utf8'))

const rule = doc.rules.find((r) => r.pathPattern === '/api/grants' && r.method === 'POST')
const step = rule.pipelineConfig.steps.find((s) => s.id === 'merge')

const ANCHOR = 'var email = body.principalEmail ? String(body.principalEmail) : null;'
const CAP = "\n  if (pid === 'anyone') { level = 'view'; email = null; }"

if (step.config.code.includes("pid === 'anyone'")) {
  console.log('cap already present — nothing to do')
  process.exit(0)
}
if (!step.config.code.includes(ANCHOR)) {
  console.error('anchor line not found in merge step — inspect the step body')
  process.exit(1)
}
step.config.code = step.config.code.replace(ANCHOR, ANCHOR + CAP)
writeFileSync(P, JSON.stringify(doc, null, 2) + '\n')
console.log('anyone view-cap inserted into grants merge')
