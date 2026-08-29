/**
 * The chip/block rule for plain text (02, apps#440). It lives beside
 * `ValueView` rather than inside it because the component file may only
 * export components (fast refresh), and the threshold is worth naming.
 */
import type { ValueDecl } from '../../lib/valueDecl'

/**
 * Past this many characters a string is a block, not a chip. A `.chip` is a
 * pill — `border-radius: 999px` — and a pill that wraps to ten lines is an
 * ellipse whose shape depends on how tall the text happens to be. 120 is
 * about one comfortable line in the pane at the harness's mono size.
 */
export const BLOCK_TEXT_LENGTH = 120

/**
 * A string is drawn as a block when the writer declared it `format: textarea`,
 * when it holds a newline, or when it is longer than `BLOCK_TEXT_LENGTH`.
 * Everything else stays a chip.
 */
export function isBlockText(decl: Pick<ValueDecl, 'format'>, text: string): boolean {
  return decl.format === 'textarea' || text.includes('\n') || text.length > BLOCK_TEXT_LENGTH
}
