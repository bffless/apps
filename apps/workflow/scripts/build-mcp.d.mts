/** Types for the ESM build script, for `src/mcp/bundle.test.ts` (`allowJs` is off). */
export const ENTRIES: readonly string[]
export const OUT_DIR: string
/** The rule-set directory the rendered rules live under. */
export const SET: string
export function outFile(name: string): string
export function bundle(name: string): Promise<string>
/** The source revision the ui:// resource URIs carry (apps#587): 8 hex chars, stable for unchanged sources. */
export function sourceRev(): string
/** package.json as the revision hashes it: the same text without its `version`, so a release bump does not re-key the URI. */
export function packageJsonForRev(text: string): string
/** Every rendered rule file: `[path relative to SET, text]`. */
export function renderedRules(): Promise<Array<[string, string]>>
