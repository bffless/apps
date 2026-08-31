import { MarkdownBody, type MarkdownBodyProps } from './MarkdownBody'
import { MermaidDiagram } from './MermaidDiagram'

/**
 * A small READ-ONLY Markdown preview (issue #68). Studio carries no Markdown
 * dependency, and the blog post is generated text we only ever display — never
 * edit — so a focused block renderer is enough. The renderer itself is
 * `MarkdownBody`; this is that body with ```mermaid fences wired to
 * `MermaidDiagram`, which is the one piece that pulls in a heavy dependency
 * (lazily) — kept out of `MarkdownBody` so workflow-studio's single-file (now a frozen copy in `bffless/workflow-implementations`)
 * blog island can render the same post without inlining `mermaid`.
 */
export function MarkdownPreview(props: Omit<MarkdownBodyProps, 'diagram'>) {
  return <MarkdownBody {...props} diagram={MermaidDiagram} />
}
