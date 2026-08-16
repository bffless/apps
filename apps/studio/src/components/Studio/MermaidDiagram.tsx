import { useEffect, useId, useState } from 'react'

/**
 * Renders a ```mermaid fenced block from the blog post as an inline SVG.
 *
 * `mermaid` is a large dependency, so it is imported lazily on first use — a post
 * with no diagram never downloads it. Until the library has loaded (and if the
 * diagram fails to parse) the source is shown as a plain code block, so the post
 * always renders SOMETHING and a broken diagram degrades to readable text with a
 * short note instead of an empty hole. `securityLevel: 'strict'` keeps mermaid's
 * own sanitizer on the generated markup.
 */
type State = { code: string } & ({ kind: 'ok'; svg: string } | { kind: 'error'; message: string })

let initialized = false

export function MermaidDiagram({ code }: { code: string }) {
  // Keyed by the code it was rendered from: a stale result for a previous
  // diagram simply reads as "loading" until the new render lands.
  const [result, setResult] = useState<State | null>(null)
  const state = result && result.code === code ? result : null
  const rawId = useId()
  // mermaid uses the id as a DOM/CSS selector; strip the colons React puts in useId.
  const id = `mmd-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const mermaid = (await import('mermaid')).default
        if (!initialized) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
          initialized = true
        }
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) setResult({ code, kind: 'ok', svg })
      } catch (e) {
        if (!cancelled) setResult({ code, kind: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, id])

  if (state?.kind === 'ok') {
    return (
      <div
        role="img"
        aria-label="Diagram"
        className="mermaid-diagram overflow-x-auto rounded-md border border-line bg-white p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <pre className="overflow-x-auto rounded-md border border-line bg-surface-dim/30 p-3 font-mono text-[12.5px] leading-snug">
        <code>{code}</code>
      </pre>
      {state?.kind === 'error' && (
        <p className="text-[12px] text-ink-soft italic">Diagram could not be rendered — showing its source. ({state.message.split('\n')[0]})</p>
      )}
    </div>
  )
}
