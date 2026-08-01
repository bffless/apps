import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface RegistryEntry {
  id: string
  name?: string
  version: string
  bundleUrl: string
  sha256: string
  summary?: string
  description?: string
  category?: string
  iconUrl?: string
  thumbnailUrl?: string
  screenshots?: string[]
  docsUrl?: string
  sourceUrl?: string
  requires?: { presignedStorage?: boolean; ceMin?: string }
}

export interface Registry {
  schemaVersion: 1
  apps: RegistryEntry[]
}

const fallback = fileURLToPath(new URL('../../dev-registry.json', import.meta.url))

/** Build-time loader: REGISTRY_FILE is set by scripts/build-store-artifact.mjs in CI;
 *  local `astro dev` falls back to the committed dev fixture. */
export function loadRegistry(): Registry {
  const file = process.env.REGISTRY_FILE ?? fallback
  const registry = JSON.parse(readFileSync(file, 'utf8')) as Registry
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.apps)) {
    throw new Error(`invalid registry at ${file}`)
  }
  return registry
}

/** registry.json carries absolute asset URLs for external consumers (CE admin);
 *  the site serves those same files itself, so render them root-relative — that
 *  way dev, previews, and production all resolve. */
export function assetPath(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
