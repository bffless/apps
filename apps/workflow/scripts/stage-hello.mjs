#!/usr/bin/env node
// Stage the workflow-hello bundle: .bffless/workflows/hello.workflow.yaml + generated index.json (06).
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { lintSource, loadDefinition } from '@bffless/workflow-lint'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(appDir, 'docs/spec/examples/hello.workflow.yaml')
const outIdx = process.argv.indexOf('--out')
const out = outIdx > -1 ? process.argv[outIdx + 1] : join(appDir, 'hello-dist')
const yaml = readFileSync(src, 'utf8')

const { findings } = lintSource(yaml, { file: 'hello.workflow.yaml' })
if (findings.some((f) => f.severity === 'error' || f.severity === 'warning')) {
  console.error('hello.workflow.yaml fails lint — a failing lint fails the publish (06):', findings)
  process.exit(1)
}
const { def } = loadDefinition(yaml)
const headlessSafe = !findings.some((f) => f.rule === 'interactive-headless')
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? execSync('git rev-parse --short HEAD').toString().trim()

const dir = join(out, '.bffless', 'workflows')
mkdirSync(dir, { recursive: true })
copyFileSync(src, join(dir, 'hello.workflow.yaml'))
writeFileSync(join(dir, 'index.json'), JSON.stringify({
  spec: 1, impl: 'hello', name: 'Hello',
  description: 'M1 test implementation: echo, slow job + poll, fail-on-purpose.',
  version, commit, generatedAt: new Date().toISOString(),
  workflows: [{
    file: 'hello.workflow.yaml', name: def.name,
    description: def.raw.description ?? '',
    inputs: Object.keys(def.inputs).length, jobs: Object.keys(def.jobs).length, headlessSafe,
  }],
  islands: [], scripts: [],
}, null, 2))
console.log('staged', join(dir, 'index.json'))
