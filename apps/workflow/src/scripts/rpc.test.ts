/**
 * The shim text is shipped as a *string* — it becomes the `data:` URL the
 * Worker is spawned from inside the sandbox frame — so nothing type-checks or
 * bundles it. These are the checks that stand in for that: it parses as a
 * script, the only `import` in it is the dynamic one that pulls in the script
 * module's own `data:` URL (a static `import`/`export` would make it a module
 * the browser cannot resolve specifiers for, and a static import is exactly
 * what a bundler would rewrite if this ever stopped being a plain literal),
 * and it talks to the page over the port it is handed rather than over
 * `self.postMessage` — the Worker's own `self` reaches the *frame*, which is
 * not the page (Decision 4).
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
    expect(SHIM_SOURCE).toMatch(/import\(\s*moduleUrl\s*\)/)
  })

  /**
   * The one message the Worker takes off `self` is the handover: after it, the
   * page is only ever reachable on the port, because the Worker's `self` is a
   * channel to the sandbox frame and the frame is not the page.
   */
  it('takes only the port handover off self, and runs off the port', () => {
    expect(SHIM_SOURCE).toMatch(/self\.onmessage\s*=/)
    const handover = SHIM_SOURCE.slice(SHIM_SOURCE.indexOf('self.onmessage'))
    expect(handover).toContain("t !== 'port'")
    expect(handover).not.toContain("'run'")
    expect(handover).toContain('event.ports[0]')
    expect(SHIM_SOURCE).toMatch(/port\.onmessage\s*=/)
  })

  it('never posts to the page on self — every reply goes down the port', () => {
    expect(SHIM_SOURCE).not.toContain('self.postMessage')
    expect(SHIM_SOURCE).toMatch(/port\.postMessage/)
  })

  it('speaks the whole protocol', () => {
    for (const kind of [
      'port',
      'ready',
      'run',
      'abort',
      'rpc:res',
      'rpc:req',
      'log',
      'annotate',
      'done',
      'error',
    ]) {
      expect(SHIM_SOURCE).toContain(`'${kind}'`)
    }
  })
})
