// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Structural guard for the DELETE /api/node proxy rule. The embedded-JS gate
 * runs only in CE's pipeline runner (validated live); this asserts the rule is
 * present and wired the way the #33 spec requires — write-gated, with the
 * object-purge / record-delete / non-empty-folder steps gated on the right
 * precomputed flags.
 */
import { describe, it, expect } from 'vitest'
import { loadProxyRules } from '../test/proxyRules'

const SCHEMA = '1c5d4802-596e-4f50-a08f-c41fb8f9fab0'

const proxy = await loadProxyRules()

const rule = proxy.rules.find((r) => r.pathPattern === '/api/node' && r.method === 'DELETE')
const step = (id: string) => rule!.pipelineConfig.steps.find((s: any) => s.id === id)

describe('handoff DELETE /api/node proxy rule', () => {
  it('exists as an enabled pipeline rule', () => {
    expect(rule).toBeTruthy()
    expect(rule!.proxyType).toBe('pipeline')
    expect(rule!.isEnabled).toBe(true)
  })

  it('has the expected pipeline steps in order', () => {
    const ids = rule!.pipelineConfig.steps.map((s: any) => s.id)
    expect(ids).toEqual([
      'pre', 'query', 'allFolders', 'children', 'gate',
      'guardNonEmpty', 'purgeObject', 'purgeSiteAssets',
      'del', 'response', 'deny401', 'deny403',
    ])
  })

  it('loads the node + folder chain + a child existence probe on the known schema', () => {
    expect(step('query').config.recordId).toBe('request.query.id')
    expect(step('query').config.schemaId).toBe(SCHEMA)
    expect(step('query').config.condition).toBe('steps.pre.idOk')
    // Widened in Task 5 so the singleton root record R is also fetched into the
    // chain (folder OR root), letting a root-scoped grantee be matched.
    expect(step('allFolders').config.filters.nodeType).toEqual({
      op: 'in',
      value: ['folder', 'root'],
    })
    // Cheap existence probe so a non-empty folder can be refused.
    expect(step('children').config.filters.parentId.value).toBe('request.query.id')
    expect(step('children').config.pageSize).toBe(1)
  })

  it('gates on WRITE access (rank >= 2) and emits the downstream flags', () => {
    const code = step('gate').config.code as string
    expect(step('gate').handlerType).toBe('function_handler')
    // Reuses the shared ACL helpers (folderChain) but requires write, not view.
    expect(code).toContain('function folderChain')
    expect(code).toContain('allow=rank(level)>=2')
    // Precomputed single-boolean conditions (the engine has no `&&` in conditions).
    expect(code).toContain('doPurge')
    expect(code).toContain('doPurgeSite')
    expect(code).toContain('doDelete')
    expect(code).toContain('guardBlocked')
  })

  it('refuses a non-empty folder with 409 before deleting', () => {
    expect(step('guardNonEmpty').handlerType).toBe('response_handler')
    expect(step('guardNonEmpty').config.status).toBe(409)
    expect(step('guardNonEmpty').config.condition).toBe('steps.gate.guardBlocked')
  })

  it('purges the stored object for files via file_delete key-mode', () => {
    expect(step('purgeObject').handlerType).toBe('file_delete')
    expect(step('purgeObject').config.key).toBe('{{steps.gate.storageKey}}')
    expect(step('purgeObject').config.condition).toBe('steps.gate.doPurge')
  })

  it("purges a Site's assets by content-path prefix (file_delete prefix-mode) with a trailing slash", () => {
    // Sites use path-passthrough storage (no manifest to enumerate). On delete
    // the whole content prefix is swept, so a future Site reusing the same path
    // can't serve stale leftover assets. The trailing slash keeps a sibling site
    // that merely shares a name-prefix (e.g. "proto" vs "proto2") untouched.
    const purge = step('purgeSiteAssets')
    expect(purge.handlerType).toBe('file_delete')
    expect(purge.config.prefix).toBe('{{steps.gate.sitePrefix}}')
    expect(purge.config.condition).toBe('steps.gate.doPurgeSite')
    const gateCode = step('gate').config.code as string
    expect(gateCode).toContain("sitePrefix=(isSite&&storageKey)?(storageKey+'/'):''")
    expect(gateCode).toContain('doPurgeSite=allow&&isSite&&!!sitePrefix')
    // The retired manifest-based enumeration stays gone.
    expect(step('siteKeys')).toBeUndefined()
    expect(gateCode).not.toContain('manifest')
  })

  it('hard-deletes the record and 200s only when actually deleted', () => {
    expect(step('del').handlerType).toBe('data_delete')
    expect(step('del').config.recordId).toBe('request.query.id')
    expect(step('del').config.schemaId).toBe(SCHEMA)
    expect(step('del').config.condition).toBe('steps.gate.doDelete')
    expect(step('response').config.status).toBe(200)
    expect(step('response').config.condition).toBe('steps.gate.doDelete')
  })

  it('returns 401 without a credential and 403 when insufficient', () => {
    expect(step('deny401').config.status).toBe(401)
    expect(step('deny401').config.condition).toBe('steps.gate.deny401')
    expect(step('deny403').config.status).toBe(403)
    expect(step('deny403').config.condition).toBe('steps.gate.deny403')
  })
})
