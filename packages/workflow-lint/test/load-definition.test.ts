import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadDefinition } from '../src/lint.js'

const hello = readFileSync(new URL('../../../apps/workflow/docs/spec/examples/hello.workflow.yaml', import.meta.url), 'utf8')

describe('loadDefinition', () => {
  it('returns the typed definition for a valid workflow', () => {
    const { def, findings } = loadDefinition(hello, { file: 'hello.workflow.yaml' })
    expect(def).not.toBeNull()
    expect(Object.keys(def!.jobs)).toEqual(['greet', 'slow', 'flaky', 'confirm'])
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
  })
  it('returns def null on schema failure, with findings', () => {
    const { def, findings } = loadDefinition('name: x\njobs: {}\n')
    expect(def).toBeNull()
    expect(findings.some((f) => f.rule === 'schema')).toBe(true)
  })
  it('the /lint module never imports node:fs', () => {
    const src = readFileSync(new URL('../src/lint.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/node:fs/)
  })
})
