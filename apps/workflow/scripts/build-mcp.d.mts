/** Types for `build-mcp.mjs`, so `src/mcp/bundle.test.ts` can import the real builder. */
export declare const ENTRIES: readonly string[]
export declare const OUT_DIR: string
export declare function outFile(name: string): string
export declare function bundle(name: string): Promise<string>
