import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import type { Definition, Step } from './types'
import { HEADLESS_AUTO_DEFAULT_MS, budgetMs, headlessMode, waitBudgetMs } from './headless'

/** One step, built through the real `toDefinition` so `step.raw` is what a YAML step really is. */
function step(raw: Record<string, unknown>): Step {
  const def = toDefinition({
    name: 'H',
    jobs: { j: { steps: [{ id: 's', uses: 'form', ...raw }] } },
  }) as Definition
  const found = def.jobs.j?.steps[0]
  if (!found) throw new Error('no step')
  return found
}

describe('headlessMode', () => {
  it('reads the bare form', () => {
    expect(headlessMode(step({ headless: 'skip' }))).toBe('skip')
    expect(headlessMode(step({ headless: 'auto' }))).toBe('auto')
  })

  it('reads the object form', () => {
    expect(headlessMode(step({ headless: { mode: 'skip', outputs: { ok: true } } }))).toBe('skip')
    expect(headlessMode(step({ headless: { mode: 'auto' } }))).toBe('auto')
  })

  it('defaults an object with no mode to auto — the schema requires one, but this is the harness default', () => {
    expect(headlessMode(step({ headless: {} }))).toBe('auto')
  })

  it('is undefined for a step that declares no headless at all, or declares nonsense', () => {
    expect(headlessMode(step({}))).toBeUndefined()
    expect(headlessMode(step({ headless: 'sometimes' }))).toBeUndefined()
    expect(headlessMode(step({ headless: { mode: 'sometimes' } }))).toBeUndefined()
  })
})

describe('budgetMs', () => {
  it('is the declared minutes in milliseconds', () => {
    expect(budgetMs(step({ 'timeout-minutes': 1 }))).toBe(60_000)
    expect(budgetMs(step({ 'timeout-minutes': 0.5 }))).toBe(30_000)
  })

  it('is undefined when the step declares no budget (or a non-numeric one)', () => {
    expect(budgetMs(step({}))).toBeUndefined()
    expect(budgetMs(step({ 'timeout-minutes': '10' }))).toBeUndefined()
  })
})

describe('waitBudgetMs', () => {
  it('prefers the declared budget in both modes', () => {
    expect(waitBudgetMs(step({ 'timeout-minutes': 2 }), false)).toBe(120_000)
    expect(waitBudgetMs(step({ 'timeout-minutes': 2 }), true)).toBe(120_000)
  })

  it('falls back to the 5-minute headless default only when the run is headless', () => {
    expect(waitBudgetMs(step({}), true)).toBe(HEADLESS_AUTO_DEFAULT_MS)
    expect(HEADLESS_AUTO_DEFAULT_MS).toBe(5 * 60_000)
    // An interactive run waits for a person for as long as it takes.
    expect(waitBudgetMs(step({}), false)).toBeUndefined()
  })
})
