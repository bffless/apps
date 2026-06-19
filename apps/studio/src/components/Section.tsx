import type { ReactNode } from 'react'

type Props = {
  eyebrow?: string
  title?: ReactNode
  children: ReactNode
  /** Render the bottom hairline rule (default true). */
  divider?: boolean
  className?: string
}

/** A page section with the shared container, spacing, and optional header. */
export function Section({ eyebrow, title, children, divider = true, className }: Props) {
  return (
    <section className={divider ? 'border-b rule' : undefined}>
      <div className={['container-page py-14 md:py-20', className].filter(Boolean).join(' ')}>
        {(eyebrow || title) && (
          <div className="mb-8 md:mb-12">
            {eyebrow && <p className="mb-4 meta-label">{eyebrow}</p>}
            {title && (
              <h2 className="max-w-3xl font-serif text-3xl leading-[1.05] tracking-[-0.01em] text-ink md:text-[40px]">
                {title}
              </h2>
            )}
          </div>
        )}
        {children}
      </div>
    </section>
  )
}

/** A terracotta period — the landing site's signature punctuation accent. */
export function Dot() {
  return <span className="text-terracotta">.</span>
}
