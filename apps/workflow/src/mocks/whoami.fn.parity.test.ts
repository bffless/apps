/**
 * `whoami`'s `me.fn.js` — the `function_handler` that replaced a JSON body
 * hand-assembled in a template (apps#381). Same `new Function` tooling as
 * `confine.fn.parity.test.ts`: the authored `.fn.js` cannot be imported, so it
 * is executed from source here and nowhere else.
 *
 * What it has to hold: three keys, always present, always strings — that is the
 * contract the SPA reads (`runStore`/`RunHeader` decide whether to offer Delete
 * from it), and CE hands the handler `undefined` for a caller it cannot tie to
 * a person. And the reason for the change at all: a value carrying a `"` or a
 * `\` now round-trips, where the template would have produced a body no JSON
 * parser accepts.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_ADMIN, MOCK_MEMBER, setMockUser } from './db'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(
  appDir,
  '.bffless',
  'proxy-rules',
  'workflow',
  'rules',
  'api',
  'workflow',
  'whoami',
  'get',
  'me.fn.js',
)

type Me = { id: string; email: string; role: string }
type MeHandler = (ctx: { user?: Record<string, unknown> }) => Me

function loadFnHandler(): MeHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

describe('whoami me.fn.js', () => {
  let handler: MeHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it('answers the three fields for a resolved member', () => {
    expect(handler({ user: { id: 'user_1', email: 'a@b.test', role: 'user', groups: [] } })).toEqual({
      id: 'user_1',
      email: 'a@b.test',
      role: 'user',
    })
  })

  it.each([
    ['no user at all (an API key with no person)', undefined],
    ['a user whose fields are null', { id: null, email: null, role: null }],
  ])('keeps all three keys, as empty strings, for %s', (_desc, user) => {
    expect(handler({ user: user as Record<string, unknown> | undefined })).toEqual({
      id: '',
      email: '',
      role: '',
    })
  })

  // The whole point of the handler: the old template spliced values straight
  // into `'{"id":"…"}'`, so one quote or backslash produced a body the client
  // could not parse. `{{{steps.me}}}` hands the escaping to CE.
  it('survives values a hand-built JSON template would have broken', () => {
    const me = handler({ user: { id: 'a"b', email: 'c\\d@e.test', role: 'us"er' } })

    expect(me).toEqual({ id: 'a"b', email: 'c\\d@e.test', role: 'us"er' })
    expect(JSON.parse(JSON.stringify(me))).toEqual(me)
  })

  it('agrees with the mock endpoint for both seeded identities', async () => {
    for (const user of [MOCK_MEMBER, MOCK_ADMIN]) {
      setMockUser(user)
      expect(await (await fetch('/api/workflow/whoami')).json()).toEqual(handler({ user: { ...user } }))
    }
  })
})
