import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { parseArgs, parseDuration, loadInputs, UsageError, USAGE } from '../src/args.js'

const dir = mkdtempSync(join(tmpdir(), 'wfh-args-'))
const inputsFile = join(dir, 'inputs.json')
writeFileSync(inputsFile, '{"greeting":"Hi"}')

describe('parseArgs — run', () => {
  test('parses the harness url, the impl/workflow pair and --inputs', () => {
    const args = parseArgs(['run', 'http://localhost:4680', 'hello/interactive', '--inputs', inputsFile])
    expect(args).toMatchObject({
      command: 'run',
      harnessUrl: 'http://localhost:4680',
      impl: 'hello',
      workflow: 'interactive',
      inputsFile,
      mocks: false,
      headed: false,
    })
    // The default budget for one unattended run.
    expect(args.command === 'run' && args.timeoutMs).toBe(60 * 60_000)
    expect(args.command === 'run' && args.out).toBeUndefined()
  })

  test('a trailing slash on the harness url is dropped, so no start url is ever double-slashed', () => {
    const args = parseArgs(['run', 'http://localhost:4680/', 'hello/interactive', '--inputs', inputsFile])
    expect(args.harnessUrl).toBe('http://localhost:4680')
  })

  test('--timeout 90m becomes milliseconds', () => {
    const args = parseArgs([
      'run',
      'http://h',
      'hello/interactive',
      '--inputs',
      inputsFile,
      '--timeout',
      '90m',
    ])
    expect(args.command === 'run' && args.timeoutMs).toBe(90 * 60_000)
  })

  test('--out, --mocks and --headed are read', () => {
    const args = parseArgs([
      'run',
      'http://h',
      'hello/interactive',
      '--inputs',
      inputsFile,
      '--out',
      '/tmp/out',
      '--mocks',
      '--headed',
    ])
    expect(args).toMatchObject({ out: '/tmp/out', mocks: true, headed: true })
  })

  test('a missing --inputs is a usage error', () => {
    expect(() => parseArgs(['run', 'http://h', 'hello/interactive'])).toThrow(UsageError)
  })

  test('a workflow reference that is not <impl>/<workflow> is a usage error', () => {
    expect(() => parseArgs(['run', 'http://h', 'interactive', '--inputs', inputsFile])).toThrow(UsageError)
  })

  test('a harness url that is not http(s) is a usage error', () => {
    expect(() => parseArgs(['run', 'localhost:4680', 'hello/interactive', '--inputs', inputsFile])).toThrow(
      UsageError,
    )
  })

  test('an unknown flag is a usage error rather than a silently ignored one', () => {
    expect(() =>
      parseArgs(['run', 'http://h', 'hello/interactive', '--inputs', inputsFile, '--turbo']),
    ).toThrow(UsageError)
  })
})

describe('parseArgs — runs', () => {
  test('parses the listing command and --last', () => {
    expect(parseArgs(['runs', 'http://h', 'hello/interactive', '--last', '5'])).toMatchObject({
      command: 'runs',
      impl: 'hello',
      workflow: 'interactive',
      last: 5,
    })
  })

  test('--last defaults to 10', () => {
    expect(parseArgs(['runs', 'http://h', 'hello/interactive'])).toMatchObject({ last: 10 })
  })
})

describe('parseArgs — no command', () => {
  test('an empty argv, --help and an unknown verb are all usage errors', () => {
    expect(() => parseArgs([])).toThrow(UsageError)
    expect(() => parseArgs(['--help'])).toThrow(UsageError)
    expect(() => parseArgs(['sprint', 'http://h', 'hello/interactive'])).toThrow(UsageError)
  })

  test('USAGE names both commands', () => {
    expect(USAGE).toContain('workflow-headless run')
    expect(USAGE).toContain('workflow-headless runs')
  })

  test('USAGE tells the truth about exit 2 and the token, which is what --help prints', () => {
    // These two drifted once already: `--help` still said "usage/auth" and
    // "reads" after the code had widened 2 to any driver fault and narrowed
    // the token to GETs. A CI author branches on this text.
    expect(USAGE).toMatch(/2\s+any driver-side fault/)
    expect(USAGE).toContain('Never a run')
    expect(USAGE).toContain('GETs of')
    expect(USAGE).not.toContain('usage/auth')
    // There is no --token flag; parseArgs rejects one, so USAGE must not offer it.
    expect(USAGE).not.toContain('--token')
    expect(() =>
      parseArgs(['run', 'http://h', 'hello/interactive', '--inputs', inputsFile, '--token', 'k']),
    ).toThrow(UsageError)
  })
})

describe('parseDuration', () => {
  test('reads ms / s / m / h suffixes, and bare numbers as seconds', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('90m')).toBe(90 * 60_000)
    expect(parseDuration('2h')).toBe(2 * 3_600_000)
    expect(parseDuration('45')).toBe(45_000)
  })

  test('rejects nonsense and non-positive budgets', () => {
    expect(() => parseDuration('soon')).toThrow(UsageError)
    expect(() => parseDuration('0')).toThrow(UsageError)
    expect(() => parseDuration('-5m')).toThrow(UsageError)
  })
})

describe('loadInputs', () => {
  test('reads the JSON object', () => {
    expect(loadInputs(inputsFile)).toEqual({ greeting: 'Hi' })
  })

  test('a missing inputs file is a usage error, not a crash', () => {
    expect(() => loadInputs(join(dir, 'nope.json'))).toThrow(UsageError)
  })

  test('an inputs file that is not a JSON object is a usage error', () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '[1,2,3]')
    expect(() => loadInputs(bad)).toThrow(UsageError)
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{oops')
    expect(() => loadInputs(broken)).toThrow(UsageError)
  })
})
