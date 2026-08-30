import { describe, expect, it } from 'vitest'
import { ALL_ORDER, WALKS } from '../src/walks/index.js'

// Later tasks (5, 7, 8, 10) each append their walk's name here as it's registered.
const REGISTERED = ['m1', 'interactive', 'hello']

describe('WALKS', () => {
  it('registers every walk added so far', () => {
    for (const name of REGISTERED) expect(typeof WALKS[name]).toBe('function')
  })
  it('all runs the Task 25 walks in order, studio last', () => {
    expect([...ALL_ORDER]).toEqual(['hello', 'headless', 'studio-audit', 'studio-headless'])
  })
})
