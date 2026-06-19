import type { ReactNode } from 'react'

type Props = {
  /** Mono eyebrow text, e.g. "EP 08 · Comments" */
  eyebrow: string
  title: ReactNode
  lead?: ReactNode
  children?: ReactNode
}

/** Per-page hero mirroring the landing site's editorial header style. */
export function PageHero({ eyebrow, title, lead, children }: Props) {
  return (
    <header className="border-b rule">
      <div className="container-page py-16 md:py-24">
        <p className="mb-5 meta-label">{eyebrow}</p>
        <h1 className="max-w-4xl font-serif text-[40px] leading-[1.02] tracking-[-0.015em] text-ink md:text-[60px]">
          {title}
        </h1>
        {lead && (
          <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-ink-soft md:text-[18px]">
            {lead}
          </p>
        )}
        {children && <div className="mt-8 flex flex-wrap items-center gap-3">{children}</div>}
      </div>
    </header>
  )
}
