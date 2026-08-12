#!/usr/bin/env node
// Peek at a Studio project's server-synced progress without opening it in a
// browser. (Opening the project page mid-run coerces a `running` auto build to
// `paused` in YOUR tab and autosaves that — this script is read-only.)
//
// Usage:
//   BFFLESS_API_KEY=… node scripts/progress.mjs [projectId]
//   env: STUDIO_BASE_URL (default https://studio.j5s.dev)
//
// With no projectId, shows the most recently updated project.

const base = (process.env.STUDIO_BASE_URL ?? 'https://studio.j5s.dev').replace(/\/$/, '')
const key = process.env.BFFLESS_API_KEY
if (!key) {
  console.error('BFFLESS_API_KEY is required (an API key for the BFFless project serving Studio)')
  process.exit(1)
}
const headers = { 'X-API-Key': key }

const listRes = await fetch(`${base}/api/projects`, { headers })
if (!listRes.ok) {
  console.error(`GET /api/projects → ${listRes.status}`)
  process.exit(1)
}
const listBody = await listRes.json()
const projects = Array.isArray(listBody) ? listBody : (listBody.projects ?? [])
projects.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
if (projects.length === 0) {
  console.log('no projects on the server')
  process.exit(0)
}

const wanted = process.argv[2]
const meta = wanted ? projects.find((p) => p.id === wanted || p.id.startsWith(wanted)) : projects[0]
if (!meta) {
  console.error(`no project matching ${wanted}; newest is ${projects[0].id}`)
  process.exit(1)
}

const age = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`
}

console.log(`${meta.id}  "${meta.name}"  phase=${meta.phase}  updated ${age(meta.updatedAt)} ago`)
console.log(`open: ${base}/project/${meta.id}/${meta.phase || 'build'}`)

const getRes = await fetch(`${base}/api/projects/get?id=${meta.id}`, { headers })
if (!getRes.ok) {
  console.error(`GET /api/projects/get → ${getRes.status}`)
  process.exit(1)
}
const body = await getRes.json()
const proj = body.project ?? body
let data = proj.data ?? {}
if (typeof data === 'string') data = JSON.parse(data)

const sources = data.sources ?? []
for (const [i, s] of sources.entries()) {
  const flags = [
    s.audioUrl ? 'audio✓' : 'audio–',
    (s.words?.length || s.transcript) ? 'transcript✓' : 'transcript–',
  ]
  console.log(`source ${i + 1}: ${s.fileName ?? '?'}  ${flags.join(' ')}`)
}

const scenes = data.scenes ?? []
console.log(`scenes: ${scenes.length}`)
for (const [i, sc] of scenes.entries()) {
  const status = sc.assembledUrl ? 'built' : (sc.status ?? 'pending')
  const span = sc.start != null && sc.end != null ? `  ${sc.start}–${sc.end}s` : ''
  console.log(`  ${i + 1}. ${sc.title ?? '(untitled)'} — ${status}${span}`)
}

const ab = data.autoBuild ?? {}
const active = (ab.active ?? [])
  .map((a) => `${a.stepId}${a.sceneId ? `@${String(a.sceneId).slice(0, 8)}` : ''}`)
  .join(', ')
console.log(`autoBuild: ${ab.status ?? 'idle'}${active ? `  active: ${active}` : ''}${ab.halt?.message ? `  halt: ${ab.halt.message}` : ''}`)
console.log(`finalCut: ${data.finalCutUrl ? 'yes' : 'no'}`)
console.log('\nNote: a `paused` status can simply mean someone opened the project page in a browser mid-run — the viewer tab demotes `running` on hydrate and autosaves it. The CI browser is unaffected; trust the CI log for liveness.')
