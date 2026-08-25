/**
 * The shim text is shipped as a *string* — it becomes a Blob URL the Worker is
 * spawned from — so nothing type-checks or bundles it. These are the checks
 * that stand in for that: it parses as a script, and the only `import` in it is
 * the dynamic one that pulls in the script module's own Blob URL (a static
 * `import`/`export` would make the Blob a module the browser cannot resolve
 * specifiers for, and a static import is exactly what a bundler would rewrite
 * if this ever stopped being a plain literal).
 *
 * `new Function` below is a *parser*, not an evaluator, and this is the one
 * place the app tolerates it (global constraints).
 */
import { describe, expect, it } from 'vitest'
import { SHIM_SOURCE } from './worker-shim'

/** A static `import`/`export` statement: the keyword at the head of a line. */
const STATIC_MODULE_STATEMENT = /^\s*(import|export)\s/m

describe('SHIM_SOURCE', () => {
  it('parses as JavaScript', () => {
    expect(() => new Function(SHIM_SOURCE)).not.toThrow()
  })

  it('has no static import or export statement', () => {
    expect(STATIC_MODULE_STATEMENT.test(SHIM_SOURCE)).toBe(false)
  })

  it('imports the script module dynamically, from the URL the host posted', () => {
    expect(SHIM_SOURCE).toContain('import(')
    expect(SHIM_SOURCE).toMatch(/import\(\s*\w+\.moduleUrl\s*\)/)
  })

  it('speaks the whole protocol', () => {
    for (const kind of ['run', 'abort', 'rpc:res', 'rpc:req', 'log', 'annotate', 'done', 'error']) {
      expect(SHIM_SOURCE).toContain(`'${kind}'`)
    }
  })
})
