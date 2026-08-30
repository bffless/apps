import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { collectSites } from '../../src/model/slots.js'
import { checkNeedsIf } from '../../src/checks/needsif.js'
import { lintSource } from '../../src/index.js'

const run = (yaml: string) => {
  const def = toDefinition(loadYaml(yaml).data)
  return checkNeedsIf(def, collectSites(def))
}

const BASE = `
name: x
on: { manual: { inputs: { blog: { type: boolean } } } }
`
const step = `{ id: s, uses: pipeline, with: { path: e } }`

test('a job with needs whose if names no status function is a warning with the fix spelled out', () => {
  const f = run(`${BASE}
jobs:
  per-video:
    steps: [${step}]
  blog:
    needs: per-video
    if: \${{ inputs.blog }}
    steps: [${step}]
`)
  expect(f).toHaveLength(1)
  expect(f[0]).toMatchObject({ rule: 'needs-if-status', severity: 'warning', path: '/jobs/blog/if' })
  expect(f[0]!.message).toMatch(/job `blog`.*runs even when `per-video` failed/)
  expect(f[0]!.hint).toMatch(/success\(\) && <condition>/)
})

test('the message lists every dependency the if no longer waits on', () => {
  const f = run(`${BASE}
jobs:
  a: { steps: [${step}] }
  b: { steps: [${step}] }
  c: { steps: [${step}] }
  d:
    needs: [a, b, c]
    if: \${{ inputs.blog }}
    steps: [${step}]
`)
  expect(f).toHaveLength(1)
  expect(f[0]!.message).toMatch(/when `a`, `b` or `c` failed/)
})

test('the bare if form (no template markers) is checked the same way', () => {
  const f = run(`${BASE}
jobs:
  a: { steps: [${step}] }
  b:
    needs: a
    if: inputs.blog == true
    steps: [${step}]
`)
  expect(f.map((x) => x.rule)).toEqual(['needs-if-status'])
})

test.each([
  ['success() && …', '${{ success() && inputs.blog }}'],
  ['bare always()', 'always()'],
  ['negated failure()', '${{ !failure() }}'],
  ['status function in one span of a mixed template', '${{ inputs.blog }} and ${{ success() }}'],
  ['an explicit needs.<job>.result gate', "${{ needs.a.result == 'success' && inputs.blog }}"],
])('a job gated by %s is clean', (_label, cond) => {
  const f = run(`${BASE}
jobs:
  a: { steps: [${step}] }
  b:
    needs: a
    if: "${cond}"
    steps: [${step}]
`)
  expect(f).toEqual([])
})

test('a job without needs is not gated on anything, so its if is left alone', () => {
  const f = run(`${BASE}
jobs:
  a:
    if: \${{ inputs.blog }}
    steps: [${step}]
`)
  expect(f).toEqual([])
})

test('a job with needs and no if keeps the default success() and is clean', () => {
  const f = run(`${BASE}
jobs:
  a: { steps: [${step}] }
  b: { needs: a, steps: [${step}] }
`)
  expect(f).toEqual([])
})

test('an if that does not parse is left to expr-parse', () => {
  const f = run(`${BASE}
jobs:
  a: { steps: [${step}] }
  b:
    needs: a
    if: \${{ inputs.blog && }}
    steps: [${step}]
`)
  expect(f).toEqual([])
})

test('the warning reaches lintSource with a source position, and nothing else fires', () => {
  // Typed outputs, so the only finding on the file is the one under test.
  const typed = `{ id: s, uses: pipeline, with: { path: e }, outputs: { t: { type: string, value: "\${{ response.t }}" } } }`
  const r = lintSource(
    `${BASE}
jobs:
  a: { steps: [${typed}] }
  b:
    needs: a
    if: \${{ inputs.blog }}
    steps: [${typed}]
`,
    { file: 'x.workflow.yaml' },
  )
  expect(r.counts).toEqual({ errors: 0, warnings: 1, notices: 0 })
  expect(r.findings[0]).toMatchObject({ rule: 'needs-if-status', path: '/jobs/b/if' })
  expect(r.findings[0]!.pos).toBeDefined()
})
