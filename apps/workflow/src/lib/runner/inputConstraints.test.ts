/**
 * `validateInputConstraints` (02): the input-specific keys `validateValue`
 * deliberately does not check — number `min`/`max`, string
 * `pattern`/`minLength`/`maxLength`, and `choice` membership (including list
 * items).
 */
import { describe, expect, it } from 'vitest'
import { validateInputConstraints } from './inputConstraints'

describe('validateInputConstraints', () => {
  it('passes null/undefined through untouched (unanswered is not a constraint failure)', () => {
    expect(validateInputConstraints({ type: 'number', min: 1 }, null)).toBeUndefined()
    expect(validateInputConstraints({ type: 'string', minLength: 3 }, undefined)).toBeUndefined()
  })

  describe('number: min/max', () => {
    it('rejects below min and above max, accepts within range', () => {
      const def = { type: 'number', min: 1, max: 5 }
      expect(validateInputConstraints(def, 0)).toMatch(/at least 1/)
      expect(validateInputConstraints(def, 6)).toMatch(/at most 5/)
      expect(validateInputConstraints(def, 1)).toBeUndefined()
      expect(validateInputConstraints(def, 5)).toBeUndefined()
      expect(validateInputConstraints(def, 3)).toBeUndefined()
    })

    it('is a no-op when min/max are not declared', () => {
      expect(validateInputConstraints({ type: 'number' }, -1000)).toBeUndefined()
    })
  })

  describe('string: minLength/maxLength/pattern', () => {
    it('rejects a string shorter than minLength or longer than maxLength', () => {
      const def = { type: 'string', minLength: 2, maxLength: 4 }
      expect(validateInputConstraints(def, 'a')).toMatch(/at least 2/)
      expect(validateInputConstraints(def, 'abcde')).toMatch(/at most 4/)
      expect(validateInputConstraints(def, 'abc')).toBeUndefined()
    })

    it('rejects a string that does not match pattern', () => {
      const def = { type: 'string', pattern: '^[a-z]+$' }
      expect(validateInputConstraints(def, 'ABC')).toMatch(/format/)
      expect(validateInputConstraints(def, 'abc')).toBeUndefined()
    })

    it('does not throw and skips the check for an invalid regex pattern', () => {
      const def = { type: 'string', pattern: '(unterminated' }
      expect(validateInputConstraints(def, 'anything')).toBeUndefined()
    })

    it('does not apply string constraints to a markdown field (02: no extra keys)', () => {
      const def = { type: 'markdown', minLength: 100 }
      expect(validateInputConstraints(def, 'short')).toBeUndefined()
    })
  })

  describe('choice: membership', () => {
    it('rejects a value outside a bare-string options list', () => {
      const def = { type: 'choice', options: ['world', 'studio', 'reader'] }
      expect(validateInputConstraints(def, 'nope')).toMatch(/not one of/)
      expect(validateInputConstraints(def, 'world')).toBeUndefined()
    })

    it('rejects a value outside a {value,label} options list', () => {
      const def = { type: 'choice', options: [{ value: 'short', label: '≈3 min' }, { value: 'medium' }] }
      expect(validateInputConstraints(def, 'long')).toMatch(/not one of/)
      expect(validateInputConstraints(def, 'medium')).toBeUndefined()
    })

    it('checks every item of a choice list, catching a stale value a prefill carried', () => {
      const def = { type: 'choice', list: true, options: ['world', 'studio', 'reader'] }
      expect(validateInputConstraints(def, ['world', 'stale-option'])).toMatch(/not one of/)
      expect(validateInputConstraints(def, ['world', 'studio'])).toBeUndefined()
    })

    it('skips the check when options cannot be read (an expression string, not an array)', () => {
      const def = { type: 'choice', options: '${{ inputs.dynamicOptions }}' }
      expect(validateInputConstraints(def, 'anything')).toBeUndefined()
    })
  })
})
