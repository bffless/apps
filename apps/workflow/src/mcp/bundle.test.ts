// @vitest-environment node
/**
 * The committed `*.fn.js` bundles of the MCP endpoint rule are what
 * `deploy-proxy-rules` syncs and what the catalog bundle ships, so they must
 * be (1) fresh — rebuilt from `src/mcp/**` — (2) admissible to CE's
 * function_handler, whose static scan refuses a fixed list of patterns, and
 * (3) runnable in the sandbox CE actually gives them, which has none of
 * Node's or the browser's globals. This suite rebuilds each entry in memory,
 * compares, scans, and runs it in a `node:vm` context shaped like CE's.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ENTRIES, SET, bundle, outFile, renderedRules, sourceRev } from '../../scripts/build-mcp.mjs'

/**
 * Verbatim `PROHIBITED_PATTERNS` from
 * `repos/ce/apps/backend/src/pipelines/function-runner.service.ts` (v0.4.40).
 * A bundle that trips one is refused at rule sync with "Invalid code".
 */
const PROHIBITED_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bFunction\s*\(/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\s*\./,
  /\bglobal\s*\./,
  /\bglobalThis\s*\./,
  /\.__proto__/,
  /\bconstructor\s*\[/,
  /\bconstructor\s*\./,
  /\bBuffer\s*\(/,
  /\bBuffer\s*\./,
]

/** The sandbox CE builds (function-runner.service.ts `run`), minus `utils` — nothing here signs anything. */
function ceSandbox(data: unknown): vm.Context {
  const logs: string[] = []
  const log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  return vm.createContext({
    data,
    Math,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    BigInt,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    decodeURI,
    decodeURIComponent,
    encodeURI,
    encodeURIComponent,
    console: { log, warn: log, error: log },
    __result__: undefined,
  })
}

/** Run a bundle the way CE does and return `handler(data)`'s settled value. */
export async function runInCeSandbox(code: string, data: unknown): Promise<unknown> {
  const sandbox = ceSandbox(data)
  const wrapped = `(async function () { ${code}\n if (typeof handler !== 'function') throw new Error('no handler'); __result__ = await handler(data) })()`
  await new vm.Script(wrapped, { filename: 'user-function.js' }).runInContext(sandbox, { timeout: 5000 })
  return sandbox.__result__
}

const SMOKE_DATA = {
  request: { body: {}, query: {}, headers: {}, method: 'POST', path: '/api/workflow/mcp-tools/status' },
  steps: {},
  deployment: { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' },
}

describe('MCP endpoint bundles', () => {
  for (const name of ENTRIES) {
    describe(name, () => {
      const committed = readFileSync(outFile(name), 'utf8')

      it('is fresh (run `pnpm --filter workflow mcp:build` after editing src/mcp/**)', async () => {
        expect(committed).toBe(await bundle(name))
      }, 30_000)

      it("carries none of CE's prohibited patterns", () => {
        for (const pattern of PROHIBITED_PATTERNS) {
          const hit = committed.match(pattern)
          expect(hit, `${pattern} at …${committed.slice(Math.max(0, (hit?.index ?? 0) - 80), (hit?.index ?? 0) + 40)}…`).toBeNull()
        }
      })

      it("runs in CE's sandbox and answers an object", async () => {
        const result = await runInCeSandbox(committed, SMOKE_DATA)
        expect(result).toBeTypeOf('object')
        expect(result).not.toBeNull()
      })
    })
  }
})

describe('the rendered MCP rules', () => {
  it('are fresh (run `pnpm --filter workflow mcp:build` after editing src/mcp/mcpConfig.ts or the generator)', async () => {
    const files = await renderedRules()
    expect(files.length).toBe(1 + 15 + 2)
    for (const [rel, text] of files) {
      expect(readFileSync(join(SET, rel), 'utf8'), rel).toBe(text)
    }
  }, 30_000)
})

describe('the source revision (apps#587)', () => {
  it('is 8 hex chars, stable across calls, and the rendered endpoint rule carries it', async () => {
    const rev = sourceRev()
    expect(rev).toMatch(/^[0-9a-f]{8}$/)
    expect(sourceRev()).toBe(rev)
    const endpoint = (await renderedRules()).find(([rel]) => rel === 'rules/api/workflow/mcp/any.rule.yaml')![1]
    expect(endpoint).toContain(`ui://bffless/workflow/step-view.${rev}.html`)
  })
})
