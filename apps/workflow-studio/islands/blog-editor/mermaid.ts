/**
 * Where the blog island gets `mermaid` from (apps#441): a pinned CDN URL, loaded at
 * runtime, NOT the package. `vite-plugin-singlefile` inlines every module the island
 * imports into its one HTML file — `mermaid` included, all of it, even behind a lazy
 * `import('mermaid')` — so the only way to render a ```mermaid fence here without
 * shipping the library in every review is to fetch it when a post actually has one.
 *
 * Why this works in the island's frame: it runs in `<iframe sandbox="allow-scripts">`
 * (opaque origin, no CSP — `IslandFrame.tsx`), and jsDelivr answers module requests
 * with `access-control-allow-origin: *`, which an `Origin: null` request satisfies.
 * The `@vite-ignore` (and the URL living in a `const`, not the `import()` itself) keep
 * Vite/Rolldown from resolving it at build time; `build.test.ts` checks the built HTML
 * still carries the URL and none of mermaid's own code. If the fetch fails (offline, a
 * blocked CDN), `createMermaidDiagram` shows the fence's source with a one-line note.
 *
 * The version is Studio's — `mermaid` in `apps/studio/package.json` — so the island
 * and the app draw the same diagram from the same fence; `mermaid.test.ts` pins them
 * together. Bump both at once.
 */
import type { MermaidLike } from 'studio/components/Studio/MermaidDiagramView'

export const MERMAID_VERSION = '11.16.1'

export const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`

export async function loadMermaid(): Promise<MermaidLike> {
  const module = (await import(/* @vite-ignore */ MERMAID_URL)) as { default: MermaidLike }
  return module.default
}
