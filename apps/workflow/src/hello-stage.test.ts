/**
 * `scripts/stage-hello.mjs` is what a real implementation's CI runs (06): lint
 * the workflow YAML, then stage `.bffless/workflows/{hello.workflow.yaml,index.json}`.
 * These tests run the actual script against a temp dir — no re-implementing its
 * logic here — and hold the result to the same shape the MSW mock's `HELLO_INDEX`
 * asserts, so the two can never quietly drift apart (parity test below).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELLO_INDEX } from './mocks/handlers'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(appDir, 'scripts', 'stage-hello.mjs')
const specYaml = join(appDir, 'docs', 'spec', 'examples', 'hello.workflow.yaml')

interface StagedWorkflow {
  file: string
  name: string
  description: string
  inputs: number
  jobs: number
  headlessSafe: boolean
}

interface StagedIndex {
  spec: number
  impl: string
  name: string
  workflows: StagedWorkflow[]
}

describe('stage-hello.mjs', () => {
  let outDir: string
  let index: StagedIndex

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'hello-stage-'))
    execFileSync('node', [script, '--out', outDir])
    index = JSON.parse(readFileSync(join(outDir, '.bffless', 'workflows', 'index.json'), 'utf8'))
  })

  it('stages an index.json with the hello workflow shape', () => {
    expect(index.impl).toBe('hello')
    expect(index.workflows).toHaveLength(1)
    expect(index.workflows[0].jobs).toBe(4)
    expect(index.workflows[0].inputs).toBe(4)
    expect(index.workflows[0].headlessSafe).toBe(true)
  })

  it('stages the workflow yaml byte-identical to the spec example', () => {
    const staged = readFileSync(join(outDir, '.bffless', 'workflows', 'hello.workflow.yaml'))
    const source = readFileSync(specYaml)
    expect(staged.equals(source)).toBe(true)
  })

  // Parity: the staged bundle's counts must equal what the MSW mock backend
  // (which every unit/integration test runs against) reports, or a passing
  // test suite could still mask a real-vs-mock drift in the discovery listing.
  it('matches the MSW mock index counts', () => {
    const mockWorkflow = HELLO_INDEX.workflows[0]
    const stagedWorkflow = index.workflows[0]
    expect(stagedWorkflow.jobs).toBe(mockWorkflow.jobs)
    expect(stagedWorkflow.inputs).toBe(mockWorkflow.inputs)
    expect(stagedWorkflow.headlessSafe).toBe(mockWorkflow.headlessSafe)
  })
})
