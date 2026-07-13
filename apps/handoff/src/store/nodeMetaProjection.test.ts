// @vitest-environment node
/**
 * The three node-shape steps must project `title` / `description` onto every node they return, and
 * must normalise an empty string to `null` (the API contract the frontend relies on: absent and
 * blank are the same thing, so the UI never renders an empty heading).
 *
 * This used to assert that each handler's SOURCE contained an exact minified snippet, e.g.
 * `title:(r.title!=null&&String(r.title)!=='')?String(r.title):null,`. That only ever tested that
 * nobody reformatted the code — it would pass on a handler that computed the value and dropped it,
 * and it broke the moment the handlers became real TypeScript (#231). It now RUNS the handlers.
 */
import { describe, expect, it } from 'vitest'
import { findRule, handlerOf, loadProxyRules } from '../test/proxyRules'

const proxy = await loadProxyRules()

const shape = (method: string, path: string) => handlerOf(findRule(proxy.rules, path, method), 'shape')

const ADMIN = { id: 'admin-1', role: 'admin' }

const ROW = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  nodeType: 'file',
  displayName: 'deck.png',
  parentId: 'root',
  ownerId: 'admin-1',
  storage_path: 'owner/repo/uploads/content/deck.png',
  content_type: 'image/png',
  size: 100,
  createdMs: 1,
}

/** The three shapes read their row from different steps — that wiring is part of what's asserted. */
const CASES = [
  {
    name: 'GET /api/node',
    run: (row: Record<string, unknown>) =>
      shape('GET', '/api/node')({ user: ADMIN, steps: { query: row, gate: { allow: true } } }).node,
  },
  {
    name: 'GET /api/nodes',
    run: (row: Record<string, unknown>) =>
      shape('GET', '/api/nodes')({
        user: ADMIN,
        // The listing shape filters children by what the viewer may see, and takes that viewer from
        // the gate step (not from `user`) — the gate is what resolved the session into a viewer.
        steps: { query: [row], allFolders: [], gate: { allow: true, viewer: { userId: 'admin-1', isAdmin: true } } },
      }).nodes[0],
  },
  {
    name: 'POST /api/nodes (register)',
    run: (row: Record<string, unknown>) =>
      shape('POST', '/api/nodes')({ user: ADMIN, request: { body: {} }, steps: { register: row } }).node,
  },
]

describe('node shape projections expose title/description', () => {
  for (const { name, run } of CASES) {
    describe(name, () => {
      it('projects a title and description that are set', () => {
        const node = run({ ...ROW, title: 'Board Deck', description: 'see slide 4' })
        expect(node.title).toBe('Board Deck')
        expect(node.description).toBe('see slide 4')
      })

      it('normalises an empty string to null', () => {
        const node = run({ ...ROW, title: '', description: '' })
        expect(node.title).toBeNull()
        expect(node.description).toBeNull()
      })

      it('projects null when absent', () => {
        const node = run({ ...ROW })
        expect(node.title).toBeNull()
        expect(node.description).toBeNull()
      })
    })
  }
})
