import { describe, expect, it } from 'vitest'
import { hello } from '../../test/helloHarness'
import { CARD, CHIP, cardHeight, chipHeight, declaredJobOutputs, declaredOutputs } from './geometry'

describe('geometry — jobs-only nodes', () => {
  it('gives every run-mode job one strip and one status line, plus the matrix note', () => {
    expect(cardHeight(hello, 'slow', 'run')).toBe(CARD.strip + CARD.status + CARD.border)
    expect(cardHeight(hello, 'greet', 'run')).toBe(CARD.strip + CARD.note + CARD.status + CARD.border)
  })
  it('adds one OUT line per declared job output in definition mode', () => {
    expect(declaredJobOutputs(hello, 'slow')).toEqual([['report', 'markdown'], ['poster', 'file']])
    expect(cardHeight(hello, 'slow', 'definition')).toBe(CARD.strip + CARD.status + 2 * CARD.out + CHIP.outPad + CARD.border)
    expect(cardHeight(hello, 'flaky', 'definition')).toBe(CARD.strip + CARD.status + CARD.border)
  })
})

/**
 * What a step *promises*, per kind (03). These four cases came from
 * `StepChip.test.tsx` (retired with the chip, Task 12): the chip read them off
 * `declaredOutputs` to draw its OUT lines, and PR 5's declared step body will
 * read them off the same function — so the fact is pinned here, on the
 * function itself, rather than on whichever component happens to draw it.
 */
describe('geometry — declaredOutputs (03)', () => {
  it("gives a declared output's own name and type", () => {
    const say = hello.jobs.greet!.steps[0]!
    expect(declaredOutputs(say)).toEqual([['line', 'string']])
  })

  it("gives a form's fields as its outputs, though it declares no `outputs` map", () => {
    const review = hello.jobs.confirm!.steps[0]!
    expect(declaredOutputs(review)).toEqual([
      ['approved', 'boolean'],
      ['report', 'markdown'],
    ])
  })

  it('gives the `response` a pipeline step exposes with no outputs map at all', () => {
    const boom = hello.jobs.flaky!.steps[0]!
    expect(declaredOutputs(boom)).toEqual([['response', 'json']])
  })

  it('is a declaration, not an attempt: it reads the workflow file and nothing else', () => {
    // The run-mode counterpart of the retired chip case — no run state is
    // consulted at all, so there is nothing a run could change here.
    const say = hello.jobs.greet!.steps[0]!
    expect(declaredOutputs(say)).toEqual(declaredOutputs(say))
    expect(chipHeight(say, 'run')).toBe(CHIP.row)
    expect(chipHeight(say, 'definition')).toBe(CHIP.row + CHIP.out + CHIP.outPad)
  })
})
