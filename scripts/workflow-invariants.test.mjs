import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows')
const read = (f) => readFileSync(join(workflowsDir, f), 'utf8')
const all = () => readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

test('exactly one workflow publishes to the app-registry alias', () => {
  const publishers = all().filter((f) => /alias:\s*app-registry\b/.test(read(f)))
  assert.deepEqual(
    publishers,
    ['release.yml'],
    `two publishers of one alias is what made the registry go stale; found ${publishers.join(', ')}`,
  )
})

test('publish-registry runs after both release and bundles', () => {
  const src = read('release.yml')
  const job = src.slice(src.indexOf('publish-registry:'))
  const needs = /needs:\s*\[([^\]]+)\]/.exec(job)
  assert.ok(needs, 'publish-registry must declare needs')
  const names = needs[1].split(',').map((s) => s.trim())
  assert.ok(names.includes('release'), names)
  assert.ok(names.includes('bundles'), names)
})

test('deploy-store.yml is gone', () => {
  assert.equal(all().includes('deploy-store.yml'), false)
})
