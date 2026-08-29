import { createMermaidDiagram } from './MermaidDiagramView'

/**
 * Renders a ```mermaid fenced block from the blog post as an inline SVG.
 *
 * `mermaid` is a large dependency, so it is imported lazily on first use — a post
 * with no diagram never downloads it. The rendering itself (source shown until the
 * library lands, source plus a short note when a diagram fails to parse, so the
 * post always renders SOMETHING rather than an empty hole) is
 * `MermaidDiagramView`'s `createMermaidDiagram`; this is that renderer over the
 * package import. `apps/workflow-studio`'s blog island builds the same renderer
 * over a CDN loader instead, so this module — the one with `import('mermaid')` in
 * it — is deliberately NOT on Studio's public surface.
 */
export const MermaidDiagram = createMermaidDiagram(async () => (await import('mermaid')).default)
