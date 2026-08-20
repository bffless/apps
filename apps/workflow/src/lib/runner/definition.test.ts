// @vitest-environment node
//
// lib/runner is pure Node/TS with no DOM dependency (spec 09). workflow-lint's
// schema loader does `readFileSync(new URL(..., import.meta.url))`; under the
// app's default jsdom test environment, jsdom's polyfilled global `URL` shadows
// Node's native one and Node's fs internals reject it ("must be of scheme
// file"). Running this file under the real `node` environment sidesteps that
// jsdom/Node URL-class mismatch without touching workflow-lint or the app's
// shared vite.config.ts.
import { describe, expect, it } from 'vitest'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './definition'

describe('loadWorkflow', () => {
  it('loads the hello example', () => {
    const { def, ok, findings } = loadWorkflow(helloYaml, 'hello.workflow.yaml')
    expect(ok, JSON.stringify(findings, null, 2)).toBe(true)
    expect(def).not.toBeNull()
    expect(Object.keys(def!.jobs)).toHaveLength(4)
    expect(def!.jobs.greet!.matrix).toBeDefined()
  })

  it('flags an unknown context root as an error while still returning a definition', () => {
    const yaml = [
      'spec: 1',
      'name: Bad context',
      'on:',
      '  manual: {}',
      'jobs:',
      '  one:',
      '    steps:',
      '      - id: step1',
      '        uses: pipeline',
      '        with:',
      '          path: echo',
      '          body: { text: "${{ bogus.x }}" }',
      '',
    ].join('\n')

    const { def, ok, findings } = loadWorkflow(yaml, 'bad.workflow.yaml')
    expect(ok).toBe(false)
    expect(def).not.toBeNull()
    expect(findings.some((f) => f.severity === 'error')).toBe(true)
  })
})
