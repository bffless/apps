import { describe, expect, it } from 'vitest'
import { hello } from '../../test/helloHarness'
import { CARD, CHIP, cardHeight, declaredJobOutputs } from './geometry'

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
