/**
 * What a value's renderer needs to know about it (02) — the shape `ValueView`
 * dispatches on.
 *
 * It lives in `lib/` rather than beside `ValueView` because `lib/outputDecls`
 * *computes* these declarations, and a module in `lib/` pointing back up into
 * `components/` is the wrong direction: lib is the layer components are built
 * on, not the other way round. `ValueView` re-exports the type, so the
 * components that already import it from there keep working.
 */
export interface ValueDecl {
  type: string
  list?: boolean
  render?: string
  /**
   * `string` only: the form control's hint (02) — `textarea` is the one the
   * viewer reads too, since it says the writer expects paragraphs (apps#440).
   */
  format?: string
  columns?: unknown
  /** `render: island` only: the island file, relative to the implementation bundle (04). */
  src?: string
  /** `render: chart`/`render: code` only: `{ x, y, kind? }` or `{ language }` (02). */
  mapping?: unknown
}
