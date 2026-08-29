import { Fragment, type ComponentType, type ReactNode } from 'react'
import type { BlogImageRef } from '../../lib/blog'
import { BlogFigure } from './BlogFigure'
import { splitBlocks } from '../../lib/markdownBlocks'

/** The optional wiring that turns a figure into a re-framable one (issue #91):
 *  the post's frame sidecar (URL → captured second) plus the capture/reframe
 *  handlers. When absent — tests, the bundle, any read-only use — the body
 *  stays exactly the plain read-only renderer it has always been. */
type Editing = {
  frames?: BlogImageRef[]
  onCaptureSiblings: (time: number) => Promise<{ time: number; thumb: string }[]>
  onPreviewFrame: (time: number) => Promise<string>
  onReframe: (oldUrl: string, time: number) => Promise<boolean>
}

export type MarkdownBodyProps = {
  markdown: string
  frames?: BlogImageRef[]
  onCaptureSiblings?: (time: number) => Promise<{ time: number; thumb: string }[]>
  onPreviewFrame?: (time: number) => Promise<string>
  onReframe?: (oldUrl: string, time: number) => Promise<boolean>
  /**
   * What a ```mermaid fence renders as. `MarkdownPreview` supplies `MermaidDiagram`;
   * a consumer that cannot carry the `mermaid` dependency (a single-file workflow
   * island, where a lazy `import('mermaid')` would be inlined wholesale) builds one
   * over its own loader with `MermaidDiagramView`'s `createMermaidDiagram`, or leaves
   * it out and the fence renders as a plain code block with its language chip.
   */
  diagram?: ComponentType<{ code: string }>
}

/**
 * The block renderer behind `MarkdownPreview` (issue #68), with the one heavy
 * dependency — the ```mermaid diagram component — injected rather than imported,
 * so this module is store-free AND mermaid-free. Everything else is here: YAML
 * front-matter (shown as a title/description header), ATX headings, unordered
 * lists, blockquotes, GFM tables, and paragraphs, with inline `**bold**`, `*italic*`,
 * and `` `code` ``, plus fenced code blocks. Anything it doesn't recognize falls
 * through as plain text, so a post always renders SOMETHING rather than breaking.
 * Not a prose editor — there is no text-editing affordance.
 *
 * Standalone Markdown image lines (`![caption](url)`) — the inline frames the blog
 * pipeline captures and uploads (issue #70) — render as a figure with the caption
 * shown visibly in italics beneath the image (alt text + a caption line). When the
 * optional editing wiring is supplied AND an image is in the frame sidecar, that
 * figure also gets a "Change frame" control to nudge it to a nearby moment (issue
 * #91); every other image stays a plain read-only figure.
 */
export function MarkdownBody({
  markdown,
  frames,
  onCaptureSiblings,
  onPreviewFrame,
  onReframe,
  diagram,
}: MarkdownBodyProps) {
  const { front, body } = splitFrontMatter(markdown)
  const editing: Editing | null =
    onCaptureSiblings && onPreviewFrame && onReframe
      ? { frames, onCaptureSiblings, onPreviewFrame, onReframe }
      : null
  return (
    <div className="prose-surface flex flex-col gap-3 text-[14px] leading-relaxed text-ink">
      {front && (front.title || front.description) && (
        <header className="border-b border-line pb-3">
          {front.title && <p className="font-semibold tracking-[-0.01em] text-[20px] leading-tight text-ink">{front.title}</p>}
          {front.description && <p className="mt-1 text-[13px] text-ink-soft">{front.description}</p>}
        </header>
      )}
      {renderBlocks(body, editing, diagram)}
    </div>
  )
}

/** Split a leading `--- ... ---` YAML front-matter block (parsed for `title` and
 *  `description`) from the Markdown body. No front-matter → `front` is null. */
function splitFrontMatter(md: string): {
  front: { title: string; description: string } | null
  body: string
} {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md)
  if (!m) return { front: null, body: md }
  const front = { title: '', description: '' }
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim())
    if (kv && (kv[1] === 'title' || kv[1] === 'description')) {
      front[kv[1] as 'title' | 'description'] = kv[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  return { front, body: md.slice(m[0].length) }
}

/** A line that is exactly a Markdown image: `![alt](url)`. */
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/

/** A table column's text alignment, from its delimiter cell (`markdownBlocks`). */
const ALIGN_CLASS = { left: 'text-left', center: 'text-center', right: 'text-right' } as const

/** Render the body as a sequence of blocks: fenced code (incl. mermaid diagrams),
 *  GFM tables, and blank-line-separated text blocks. */
function renderBlocks(
  body: string,
  editing: Editing | null,
  Diagram: ComponentType<{ code: string }> | undefined,
): ReactNode[] {
  const timeByUrl = new Map((editing?.frames ?? []).map((f) => [f.url, f.time]))
  return splitBlocks(body).map((blk, i) => {
    if (blk.kind === 'code') {
      if (blk.lang === 'mermaid' && Diagram) return <Diagram key={i} code={blk.code} />
      return (
        <div key={i} className="relative">
          {blk.lang && (
            <span className="absolute right-2 top-1.5 rounded bg-surface-dim/50 px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide text-ink-soft">
              {blk.lang}
            </span>
          )}
          <pre className="overflow-x-auto rounded-md border border-line bg-surface-dim/30 p-3 font-mono text-[12.5px] leading-snug">
            <code data-lang={blk.lang || undefined}>{blk.code}</code>
          </pre>
        </div>
      )
    }
    if (blk.kind === 'table') {
      // The wrapper scrolls, never the page: a wide table stays inside whatever column
      // the body sits in (`min-w-0` so a flex parent can't be pushed wider either).
      const cls = (col: number) => (blk.align[col] ? ALIGN_CLASS[blk.align[col]] : 'text-left')
      return (
        <div key={i} className="min-w-0 max-w-full overflow-x-auto">
          <table className="min-w-full border-collapse text-[13px] leading-snug">
            <thead>
              <tr>
                {blk.header.map((cell, j) => (
                  <th key={j} className={`border border-line bg-surface-dim/30 px-2.5 py-1.5 font-semibold text-ink ${cls(j)}`}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {blk.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, j) => (
                    <td key={j} className={`border border-line px-2.5 py-1.5 align-top ${cls(j)}`}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    const block = blk.text
    const lines = block.split('\n')

    // A block of standalone image lines → one figure each, caption shown in italics.
    // An image the frame sidecar knows the timestamp of gets the re-frame control.
    if (lines.every((l) => IMAGE_LINE.test(l.trim()))) {
      return (
        <div key={i} className="flex flex-col gap-3">
          {lines.map((l, j) => {
            const m = IMAGE_LINE.exec(l.trim())
            const alt = m?.[1].trim() ?? ''
            const src = m?.[2] ?? ''
            const time = editing ? timeByUrl.get(src) : undefined
            if (editing && time !== undefined) {
              return (
                <BlogFigure
                  key={j}
                  src={src}
                  alt={alt}
                  time={time}
                  capture={editing.onCaptureSiblings}
                  preview={editing.onPreviewFrame}
                  reframe={editing.onReframe}
                />
              )
            }
            return (
              <figure key={j} className="flex flex-col gap-1">
                <img src={src} alt={alt} className="rounded-md border border-line" />
                {alt && <figcaption className="text-[12.5px] text-ink-soft italic">{alt}</figcaption>}
              </figure>
            )
          })}
        </div>
      )
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0])
    if (heading && lines.length === 1) {
      const level = heading[1].length
      const cls = level <= 1 ? 'font-semibold tracking-[-0.01em] text-[18px]' : 'font-semibold tracking-[-0.01em] text-[15px]'
      return (
        <p key={i} className={`${cls} text-ink`}>
          {renderInline(heading[2])}
        </p>
      )
    }

    if (lines.every((l) => /^[-*]\s+/.test(l))) {
      return (
        <ul key={i} className="list-disc pl-5">
          {lines.map((l, j) => (
            <li key={j}>{renderInline(l.replace(/^[-*]\s+/, ''))}</li>
          ))}
        </ul>
      )
    }

    if (lines.every((l) => /^>\s?/.test(l))) {
      return (
        <blockquote key={i} className="border-l-2 border-line pl-3 text-ink-soft italic">
          {renderInline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}
        </blockquote>
      )
    }

    return <p key={i}>{renderInline(lines.join(' '))}</p>
  })
}

/** Render inline `[text](url)` links, `**bold**`, `*italic*` / `_italic_`, and
 *  `` `code` `` spans. The link alternative also swallows an optional leading `!`
 *  so an inline image token (`![alt](url)`) still falls through as plain text —
 *  images are rendered as figures at the block level, not inline. */
function renderInline(text: string): ReactNode {
  const parts = text
    .split(/(!?\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g)
    .filter((s) => s !== '')
  return parts.map((part, i) => {
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link)
      return (
        <a
          key={i}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline decoration-1 underline-offset-2 hover:text-accent-hover"
        >
          {link[1]}
        </a>
      )
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`'))
      return (
        <code key={i} className="rounded bg-surface-dim/30 px-1 font-mono text-[12.5px]">
          {part.slice(1, -1)}
        </code>
      )
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_')))
      return <em key={i}>{part.slice(1, -1)}</em>
    return <Fragment key={i}>{part}</Fragment>
  })
}
