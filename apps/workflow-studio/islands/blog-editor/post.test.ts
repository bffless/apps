/**
 * The pure half of the `blog-editor` island: narrowing the step's `with`, and the
 * arithmetic between the post's `frame:<t>` tokens and the `by_time` map.
 */
import { describe, expect, it } from 'vitest'
import { capturedTimes, parseArgs, retimeFrameTokens, siblingTimes, tokenTimes } from './post'

const still = (key: string) => `workflows/run/frames/0/still-${key}.jpg`

describe('parseArgs', () => {
  it('keeps a string post and a by_time of finite-second keys to non-empty paths', () => {
    const parsed = parseArgs({
      post: '# Hi',
      by_time: { '40': still('40'), '45.5': still('45.5'), abc: still('x'), '50': '', '55': 7 },
    })
    expect(parsed).toEqual({ post: '# Hi', byTime: { '40': still('40'), '45.5': still('45.5') } })
  })

  it('degrades a missing post or a by_time that is not a map to empty', () => {
    expect(parseArgs({})).toEqual({ post: '', byTime: {} })
    // The frames pipeline answering nothing hands the step `[]`, not `{}`.
    expect(parseArgs({ post: 5, by_time: [] })).toEqual({ post: '', byTime: {} })
  })
})

describe('tokenTimes / capturedTimes', () => {
  it('lists distinct token seconds in first-appearance order', () => {
    expect(tokenTimes('![a](frame:83.5)\n\n![b](frame:5)\n\n![c](frame:83.5)')).toEqual([83.5, 5])
  })

  it('lists captured seconds ascending', () => {
    expect(capturedTimes({ '70': still('70'), '10': still('10'), '45.5': still('45.5') })).toEqual([10, 45.5, 70])
  })
})

describe('siblingTimes', () => {
  const byTime = Object.fromEntries(
    [0, 5, 10, 15, 40, 60, 70, 71, 100, 300].map((t) => [String(t), still(String(t))]),
  )

  it('offers every captured second within ±30 s, the figure’s own included', () => {
    expect(siblingTimes(byTime, 40)).toEqual([10, 15, 40, 60, 70])
  })

  it('is inclusive at the window’s edges and empty far from any capture', () => {
    expect(siblingTimes(byTime, 71)).toEqual([60, 70, 71, 100])
    expect(siblingTimes(byTime, 200)).toEqual([])
  })
})

describe('retimeFrameTokens', () => {
  const post = '---\ntitle: T\n---\n\n![The diff](frame:40)\n\nProse.\n\n![Again](frame:40)\n\n![Other](frame:120)\n'

  it('retimes every token at the old second, keeping each caption', () => {
    const out = retimeFrameTokens(post, 40, 45)
    expect(out).toBe('---\ntitle: T\n---\n\n![The diff](frame:45)\n\nProse.\n\n![Again](frame:45)\n\n![Other](frame:120)\n')
  })

  it('is a no-op for the same second or a second the post does not use', () => {
    expect(retimeFrameTokens(post, 40, 40)).toBe(post)
    expect(retimeFrameTokens(post, 7, 45)).toBe(post)
  })

  it('handles a token written with spaces inside the parens', () => {
    expect(retimeFrameTokens('![c]( frame:12 )', 12, 14)).toBe('![c](frame:14)')
  })
})
