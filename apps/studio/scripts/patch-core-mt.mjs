/**
 * Patch @ffmpeg/core-mt so its multithreaded core actually loads under Vite.
 *
 * The bug: core-mt's ESM pthread worker (`ffmpeg-core.worker.js`) is written for
 * a MODULE worker — it pulls in the core with dynamic `import()`. But emscripten's
 * `allocateUnusedWorker` spawns it with `new Worker(url)` — no `{type:"module"}` —
 * so the browser loads it as a CLASSIC worker and dies on the `import` with
 * "Cannot use import statement outside a module". This is the long-standing
 * core-mt ↔ @ffmpeg/ffmpeg@0.12.x module-worker incompatibility.
 *
 * The fix is one addition: pass `{type:"module"}` to both `new Worker(...)` calls
 * in the ESM core so the pthread workers load as module workers (matching how the
 * worker file is written). Runs on `postinstall` so it survives a fresh install in
 * CI / deploy. Idempotent: a no-op once patched; exits non-zero if the target
 * strings are gone (e.g. a core-mt version bump) so the drift is caught.
 *
 * Second patch: raise the heap from 1 GiB to 3 GiB. core-mt creates its shared
 * `WebAssembly.Memory` with `initial === maximum` (pthread memory can't grow), so
 * the build's 1 GiB default is a HARD cap — and `@ffmpeg/ffmpeg`'s loader never
 * passes `INITIAL_MEMORY`, so it can't be raised at load time. The per-scene
 * assemble OOMs at 1 GiB; 3 GiB clears it while staying under the 4 GiB wasm32
 * ceiling (getFFmpeg() falls back to the ST core if a device refuses it).
 *
 * The heap patch has TWO halves, both required: the glue's `INITIAL_MEMORY` (what
 * the JS offers) AND the .wasm binary's memory import limits (instantiation
 * refuses a memory whose max exceeds the declared max). 16384 pages (1 GiB) and
 * 49152 pages (3 GiB) share the same LEB128 byte length (`80 80 01` / `80 80 03`),
 * so it's an in-place byte rewrite. The limits are FOUND by parsing the import
 * section (the build is closure-minified, so the import is `a.a`, not `env.memory`)
 * and anything unexpected is a hard error so a core-mt bump can't half-patch.
 *
 * NB: pnpm-specific. `.npmrc` sets `package-import-method=copy` so editing this
 * file in node_modules doesn't write through a hardlink into the shared store, and
 * `enable-pre-post-scripts=true` so this postinstall runs at all. `pnpm patch` is
 * NOT used — its binary diff corrupts the 32 MB wasm.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const FILE = 'node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.js'
const WASM_FILE = 'node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm'

/** 64 KiB wasm pages: the build's 1 GiB default and our 3 GiB target. */
const PAGES_1GIB = 16384
const PAGES_3GIB = 49152
/** LEB128 of PAGES_3GIB — same 3-byte length as PAGES_1GIB's, so in-place. */
const LEB_3GIB = [0x80, 0x80, 0x03]

const EDITS = [
  {
    from: 'worker=new Worker(new URL("ffmpeg-core.worker.js",import.meta.url))',
    to: 'worker=new Worker(new URL("ffmpeg-core.worker.js",import.meta.url),{type:"module"})',
  },
  {
    from: 'worker=new Worker(pthreadMainJs)',
    to: 'worker=new Worker(pthreadMainJs,{type:"module"})',
  },
  {
    // 1 GiB → 3 GiB. initial === maximum on the shared memory, so this default
    // is the only heap the multithreaded core will ever have.
    from: 'INITIAL_MEMORY=Module["INITIAL_MEMORY"]||1073741824',
    to: 'INITIAL_MEMORY=Module["INITIAL_MEMORY"]||3221225472',
  },
]

if (!existsSync(FILE)) {
  // core-mt not installed (e.g. a checkout that doesn't need it) — nothing to do.
  console.log(`[patch-core-mt] ${FILE} not found; skipping.`)
  process.exit(0)
}

let src = readFileSync(FILE, 'utf8')
let changed = 0
for (const { from, to } of EDITS) {
  if (src.includes(to)) continue // already patched
  if (!src.includes(from)) {
    console.error(
      `[patch-core-mt] target not found:\n  ${from}\n` +
        `core-mt may have changed — re-check the worker-creation fix.`,
    )
    process.exit(1)
  }
  src = src.split(from).join(to)
  changed++
}

if (changed) {
  writeFileSync(FILE, src)
  console.log(`[patch-core-mt] glue: applied ${changed} patch(es).`)
} else {
  console.log('[patch-core-mt] glue: already patched.')
}

// ---- .wasm import-limits patch (the other half of the 3 GiB heap) ----------

/**
 * Walk the binary's import section and return the memory import's limits:
 * `{ flags, min, max, maxStart, maxEnd }` (offsets bracket the max's LEB bytes).
 * Throws on anything structurally unexpected — better a loud postinstall
 * failure than a core that LinkErrors at runtime.
 */
function findMemoryImportLimits(buf) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error('not a wasm binary (bad magic)')
  let p = 8 // magic + version
  const leb = () => {
    let r = 0
    let s = 0
    let b
    do {
      b = buf[p++]
      r |= (b & 0x7f) << s
      s += 7
    } while (b & 0x80)
    return r >>> 0
  }
  while (p < buf.length) {
    const id = buf[p++]
    const size = leb()
    const end = p + size
    if (id !== 2) {
      p = end
      continue
    }
    const count = leb()
    for (let i = 0; i < count; i++) {
      // NB: not `p += leb()` — that reads p BEFORE leb() advances it.
      const modLen = leb()
      p += modLen // module name
      const fieldLen = leb()
      p += fieldLen // field name
      const kind = buf[p++]
      if (kind === 0x00) leb() // func: type index
      else if (kind === 0x01) {
        p++ // table: elem type
        const f = buf[p++]
        leb()
        if (f & 1) leb()
      } else if (kind === 0x02) {
        const flags = buf[p++]
        const min = leb()
        if (!(flags & 1)) throw new Error('memory import has no maximum (expected a fixed shared memory)')
        const maxStart = p
        const max = leb()
        return { flags, min, max, maxStart, maxEnd: p }
      } else if (kind === 0x03) p += 2 // global: valtype + mutability
      else throw new Error(`unknown import kind 0x${kind.toString(16)}`)
    }
    throw new Error('no memory import in the import section')
  }
  throw new Error('no import section found')
}

if (!existsSync(WASM_FILE)) {
  console.log(`[patch-core-mt] ${WASM_FILE} not found; skipping.`)
} else {
  const wasm = readFileSync(WASM_FILE)
  const lim = findMemoryImportLimits(wasm)
  if (lim.max === PAGES_3GIB) {
    console.log('[patch-core-mt] wasm: already patched (max 3 GiB).')
  } else {
    if (lim.flags !== 0x03 || lim.min !== PAGES_1GIB || lim.max !== PAGES_1GIB) {
      console.error(
        `[patch-core-mt] unexpected memory import limits (flags=${lim.flags} min=${lim.min} max=${lim.max}); ` +
          'core-mt may have changed — re-check the heap patch.',
      )
      process.exit(1)
    }
    if (lim.maxEnd - lim.maxStart !== LEB_3GIB.length) {
      console.error('[patch-core-mt] max limit LEB length changed; in-place rewrite is unsafe — re-check.')
      process.exit(1)
    }
    Buffer.from(LEB_3GIB).copy(wasm, lim.maxStart)
    const check = findMemoryImportLimits(wasm)
    if (check.max !== PAGES_3GIB) {
      console.error('[patch-core-mt] wasm rewrite verification failed; not writing.')
      process.exit(1)
    }
    writeFileSync(WASM_FILE, wasm)
    console.log(`[patch-core-mt] wasm: memory import max ${lim.max} → ${check.max} pages (3 GiB).`)
  }
}
