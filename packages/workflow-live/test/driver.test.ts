import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { driverCliPath, outcomeOf } from '../src/driver.js'

describe('driver', () => {
  it('resolves the workspace driver CLI', () => {
    const p = driverCliPath()
    expect(p).toMatch(/workflow-headless\/dist\/cli\.js$/)
    expect(existsSync(p)).toBe(true)   // CI builds workflow-headless before this package's tests
  })
  it('maps exit codes', () => {
    expect(outcomeOf(0)).toBe('succeeded'); expect(outcomeOf(1)).toBe('failed'); expect(outcomeOf(2)).toBe('driver-fault')
    expect(outcomeOf(3)).toBe('invalid'); expect(outcomeOf(4)).toBe('timeout'); expect(outcomeOf(130)).toBe('interrupted')
  })
})
