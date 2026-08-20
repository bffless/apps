import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  it('the /lint module and its entire transitive import graph are fs-free', () => {
    const lintEntry = fileURLToPath(new URL('../src/lint.ts', import.meta.url))
    const visited = new Set<string>()
    const offenders: string[] = []

    const walk = (file: string): void => {
      if (visited.has(file)) return
      visited.add(file)
      const src = readFileSync(file, 'utf8')
      if (/from\s+['"]node:/.test(src)) offenders.push(file)
      for (const m of src.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
        const specifier = m[1]
        // Compiled specifiers end in .js; the source files they came from are .ts.
        const resolved = resolve(dirname(file), specifier).replace(/\.js$/, '.ts')
        walk(resolved)
      }
    }

    walk(lintEntry)

    expect(offenders).toEqual([])
    // Sanity check the walk actually traversed something beyond the entry file,
    // so this test can't silently pass by finding zero imports.
    expect(visited.size).toBeGreaterThan(1)
  })
})
