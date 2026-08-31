/**
 * The `project` rule's `project.fn.js` — the serving project from CE's
 * `deployment` provenance root (apps#363). Same `new Function` tooling as
 * `whoami.fn.parity.test.ts`: the authored `.fn.js` cannot be imported, so it
 * is executed from source here and nowhere else.
 *
 * What it has to hold: the body is pre-serialized (`repositoryJson`, rendered
 * with `{{{…}}}` — whoami's quote-safe shape, apps#381), `repository` is
 * `"<owner>/<repo>"` when provenance is present and `null` (never a dropped
 * key) when it is not — the SPA reads `null` as "stay unscoped".
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(
  appDir,
  '.bffless',
  'proxy-rules',
  'workflow',
  'rules',
  'api',
  'workflow',
  'project',
  'get',
  'project.fn.js',
)

type ProjectHandler = (ctx: { deployment?: Record<string, unknown> }) => { repositoryJson: string }

function loadFnHandler(): ProjectHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory() as ProjectHandler
}

describe('project project.fn.js', () => {
  let handler: ProjectHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it('names the serving project from deployment provenance', () => {
    const { repositoryJson } = handler({
      deployment: { owner: 'bffless', repo: 'workflow', commitSha: 'abc', alias: 'workflow' },
    })
    expect(JSON.parse(repositoryJson)).toEqual({ repository: 'bffless/workflow' })
  })

  it.each([
    ['no deployment root at all', undefined],
    ['an owner without a repo', { owner: 'bffless' }],
    ['non-string provenance fields', { owner: 1, repo: 2 }],
  ])('answers a null repository, never a dropped key, for %s', (_desc, deployment) => {
    const { repositoryJson } = handler({
      deployment: deployment as Record<string, unknown> | undefined,
    })
    expect(JSON.parse(repositoryJson)).toEqual({ repository: null })
  })

  // The reason the body is a pre-serialized field at all: a template splicing
  // `{{…}}` into '{"repository":"…"}' would break on a `"` or `\` in a name.
  it('survives values a hand-built JSON template would have broken', () => {
    const { repositoryJson } = handler({ deployment: { owner: 'a"b', repo: 'c\\d' } })
    expect(JSON.parse(repositoryJson)).toEqual({ repository: 'a"b/c\\d' })
  })

  it('agrees with the mock endpoint for the mock project', async () => {
    const mocked = await (await fetch('/api/workflow/project')).json()
    const authored = JSON.parse(
      handler({ deployment: { owner: 'bffless', repo: 'workflow' } }).repositoryJson,
    )
    expect(mocked).toEqual(authored)
  })
})
