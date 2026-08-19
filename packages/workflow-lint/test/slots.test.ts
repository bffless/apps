import { test, expect } from 'vitest'
import { loadYaml } from '../src/yaml/load.js'
import { toDefinition, stepOutputNames } from '../src/model/definition.js'
import { collectSites } from '../src/model/slots.js'
import { allowedRoots } from '../src/model/contexts.js'

const YAML = `
name: Slots fixture
on:
  manual:
    inputs:
      names: { type: choice, options: [a, b], list: true }
jobs:
  fan:
    strategy:
      matrix: { who: "\${{ inputs.names }}" }
    steps:
      - id: say
        uses: pipeline
        if: \${{ inputs.names != null }}
        with:
          path: echo
          body: { text: "hi \${{ matrix.who }}", nested: { deep: "\${{ inputs.names }}" } }
          query: { q: "\${{ matrix.who }}" }
        poll:
          path: job
          query: { id: "\${{ response.jobId }}" }
          until: \${{ response.status == 'done' }}
        retry: { max: 1, if: "\${{ error.code == 'BUSY' }}" }
        outputs:
          line: { type: string, value: "\${{ response.text }}" }
        summary: "Said \${{ steps.say.outputs.line }}"
        annotations:
          - { level: notice, if: "\${{ true }}", message: "m \${{ steps.say.outputs.line }}" }
    outputs:
      lines: \${{ steps.say.outputs.line }}
  ask:
    needs: fan
    steps:
      - id: review
        uses: form
        with:
          fields:
            ok: { type: boolean, default: "\${{ inputs.names != null }}" }
        headless: { mode: skip, outputs: { ok: "\${{ needs.fan.outputs.lines[0] }}" } }
outputs:
  lines: \${{ jobs.fan.outputs.lines }}
`

const def = toDefinition(loadYaml(YAML).data)
const sites = collectSites(def)
const at = (pointer: string) => sites.filter((s) => s.pointer === pointer)

test('collects every expression with its pointer and slot', () => {
  expect(at('/jobs/fan/steps/0/if')[0]!.slot).toMatchObject({ where: 'step-if', isIf: true, stepUses: 'pipeline' })
  expect(at('/jobs/fan/steps/0/with/body/text')[0]!.slot.where).toBe('body')
  expect(at('/jobs/fan/steps/0/with/body/nested/deep')[0]!.slot.where).toBe('body')
  expect(at('/jobs/fan/steps/0/with/query/q')[0]!.slot.where).toBe('query')
  expect(at('/jobs/fan/steps/0/poll/query/id')[0]!.slot.where).toBe('poll-query')
  expect(at('/jobs/fan/steps/0/poll/until')[0]!.slot.where).toBe('poll')
  expect(at('/jobs/fan/steps/0/retry/if')[0]!.slot).toMatchObject({ where: 'retry-if', isIf: true })
  expect(at('/jobs/fan/steps/0/outputs/line/value')[0]!.slot.where).toBe('step-output-value')
  expect(at('/jobs/fan/steps/0/summary')[0]!.slot.where).toBe('summary')
  expect(at('/jobs/fan/steps/0/annotations/0/message')[0]!.slot.where).toBe('annotation-message')
  expect(at('/jobs/fan/outputs/lines')[0]!.slot.where).toBe('job-output')
  expect(at('/jobs/fan/strategy/matrix/who')[0]!.slot.where).toBe('matrix')
  expect(at('/jobs/ask/steps/0/with/fields/ok/default')[0]!.slot.where).toBe('with')
  expect(at('/jobs/ask/steps/0/headless/outputs/ok')[0]!.slot.where).toBe('headless-output')
  expect(at('/outputs/lines')[0]!.slot.where).toBe('top-output')
})

test('isWholeValue distinguishes interpolation from single expressions', () => {
  expect(at('/jobs/fan/steps/0/with/body/text')[0]!.isWholeValue).toBe(false)
  expect(at('/jobs/fan/steps/0/with/body/nested/deep')[0]!.isWholeValue).toBe(true)
  expect(at('/jobs/fan/outputs/lines')[0]!.isWholeValue).toBe(true)
})

test('allowedRoots follows the 01 contexts table', () => {
  const fan = def.jobs.fan!
  const ask = def.jobs.ask!
  const bodySlot = at('/jobs/fan/steps/0/with/body/text')[0]!.slot
  const pollSlot = at('/jobs/fan/steps/0/poll/until')[0]!.slot
  const topSlot = at('/outputs/lines')[0]!.slot
  const formDefault = at('/jobs/ask/steps/0/with/fields/ok/default')[0]!.slot

  expect(allowedRoots(bodySlot, fan).has('response')).toBe(false)
  expect(allowedRoots(pollSlot, fan).has('response')).toBe(true)
  expect(allowedRoots(bodySlot, fan).has('matrix')).toBe(true)
  expect(allowedRoots(formDefault, ask).has('matrix')).toBe(false)
  expect(allowedRoots(formDefault, ask).has('response')).toBe(false)
  expect(allowedRoots(topSlot).has('jobs')).toBe(true)
  expect(allowedRoots(topSlot).has('needs')).toBe(false)
  expect(allowedRoots(at('/jobs/fan/strategy/matrix/who')[0]!.slot, fan).has('needs')).toBe(true)
  expect(allowedRoots(at('/jobs/fan/strategy/matrix/who')[0]!.slot, fan).has('matrix')).toBe(false)
  // error: first step only via retry/annotations
  expect(allowedRoots(at('/jobs/fan/steps/0/retry/if')[0]!.slot, fan).has('error')).toBe(true)
  expect(allowedRoots(bodySlot, fan).has('error')).toBe(false)
})

test('stepOutputNames resolves each kind', () => {
  expect(stepOutputNames(def.jobs.fan!.steps[0]!)).toEqual(['line'])
  expect(stepOutputNames(def.jobs.ask!.steps[0]!)).toEqual(['ok'])
})
