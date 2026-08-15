import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const actionYml = readFileSync(join(here, '../../action.yml'), 'utf8')
const rootPackageJson = readFileSync(join(here, '../../../../../package.json'), 'utf8')

describe('action.yml pnpm version', () => {
  it('matches the root package.json packageManager version', () => {
    const installedVersion = actionYml.match(/npm install -g pnpm@([\d.]+)/)?.[1]
    const pinnedVersion = rootPackageJson.match(/"packageManager":\s*"pnpm@([\d.]+)"/)?.[1]

    expect(installedVersion).toBeTruthy()
    expect(pinnedVersion).toBeTruthy()
    expect(installedVersion).toBe(pinnedVersion)
  })
})
