import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { openStep, parseStepKey } from './steps.js'

describe('parseStepKey', () => {
  it('splits a step key into job/index/stepId', () => {
    expect(parseStepKey('review/0/confirm')).toEqual({ job: 'review', index: '0', stepId: 'confirm' })
    expect(parseStepKey('card/2/draw')).toEqual({ job: 'card', index: '2', stepId: 'draw' })
  })
})

/**
 * A minimal Playwright-`Locator`-shaped fake: each `.locator()`/`.getByTestId()`
 * call extends a selector path, and `count`/`getAttribute`/`isVisible` are
 * looked up by that path's joined key from the scenario's fixtures — so a
 * test locks down *which* selectors `openStep` visits and in what order
 * (`log`), without a real browser.
 */
function fakePage(fixtures: { counts?: Record<string, number>; attrs?: Record<string, Record<string, string>>; visible?: Record<string, boolean> }) {
  const log: string[] = []
  const key = (path: string[]) => path.join(' > ')
  const makeLocator = (path: string[]): unknown => ({
    locator: (sel: string) => makeLocator([...path, sel]),
    getByTestId: (id: string) => makeLocator([...path, `testid:${id}`]),
    count: async () => fixtures.counts?.[key(path)] ?? 0,
    getAttribute: async (name: string) => fixtures.attrs?.[key(path)]?.[name] ?? null,
    isVisible: async () => fixtures.visible?.[key(path)] ?? false,
    waitFor: async () => { log.push(`waitFor:${key(path)}`) },
    click: async () => { log.push(`click:${key(path)}`) },
  })
  const page = { locator: (sel: string) => makeLocator([sel]) }
  return { page: page as unknown as Page, log }
}

const ROW = '[data-testid="step"][data-key="review/0/confirm"]'
const RAIL = 'nav[aria-label="Run"]'
const PLAIN_LINK = '[data-testid="rail-job"][data-job="review"]:not([data-index])'
const PANE = 'li:has([data-testid="step"][data-key="review/0/confirm"])'

describe('openStep', () => {
  it('skips the rail entirely when the row is already open', async () => {
    const { page, log } = fakePage({ counts: { [ROW]: 1 }, attrs: { [ROW]: { 'aria-expanded': 'true' } } })
    await openStep(page, 'review/0/confirm')
    expect(log).toEqual([`waitFor:${PANE} > testid:step-pane`])
  })

  it('clicks the plain job rail link, then the row, when the row opens on its own', async () => {
    const { page, log } = fakePage({
      counts: { [ROW]: 0 },
      attrs: { [ROW]: { 'aria-expanded': 'true' } }, // open by the time we re-check, post-navigation
    })
    await openStep(page, 'review/0/confirm')
    expect(log).toEqual([`click:${RAIL} > ${PLAIN_LINK}`, `waitFor:${ROW}`, `waitFor:${PANE} > testid:step-pane`])
  })

  it('clicks the row itself when following the rail link does not auto-open it', async () => {
    const { page, log } = fakePage({
      counts: { [ROW]: 0 },
      attrs: { [ROW]: { 'aria-expanded': 'false' } },
    })
    await openStep(page, 'review/0/confirm')
    expect(log).toEqual([`click:${RAIL} > ${PLAIN_LINK}`, `waitFor:${ROW}`, `click:${ROW}`, `waitFor:${PANE} > testid:step-pane`])
  })

  it('expands a collapsed matrix group before clicking a hidden item link', async () => {
    const matrixGroup = `${RAIL} > [data-testid="rail-matrix"][data-job="card"]`
    const itemLink = `${matrixGroup} > [data-testid="rail-job"][data-job="card"][data-index="2"]`
    const chevron = `${matrixGroup} > button[aria-expanded="false"]`
    const row = '[data-testid="step"][data-key="card/2/draw"]'
    const pane = 'li:has([data-testid="step"][data-key="card/2/draw"])'
    const { page, log } = fakePage({
      counts: { [row]: 0, [matrixGroup]: 1 },
      visible: { [itemLink]: false },
      attrs: { [row]: { 'aria-expanded': 'true' } },
    })
    await openStep(page, 'card/2/draw')
    expect(log).toEqual([`click:${chevron}`, `click:${itemLink}`, `waitFor:${row}`, `waitFor:${pane} > testid:step-pane`])
  })

  it('clicks a matrix item link directly when it is already visible', async () => {
    const matrixGroup = `${RAIL} > [data-testid="rail-matrix"][data-job="card"]`
    const itemLink = `${matrixGroup} > [data-testid="rail-job"][data-job="card"][data-index="0"]`
    const row = '[data-testid="step"][data-key="card/0/draw"]'
    const pane = 'li:has([data-testid="step"][data-key="card/0/draw"])'
    const { page, log } = fakePage({
      counts: { [row]: 0, [matrixGroup]: 1 },
      visible: { [itemLink]: true },
      attrs: { [row]: { 'aria-expanded': 'true' } },
    })
    await openStep(page, 'card/0/draw')
    expect(log).toEqual([`click:${itemLink}`, `waitFor:${row}`, `waitFor:${pane} > testid:step-pane`])
  })
})
