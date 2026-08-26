/**
 * hello's `script` step (03): draw a poster for the line the island picked.
 *
 * Copied verbatim into the bundle by `scripts/stage-hello.mjs` — no build, no
 * imports — and fetched by the harness from `/w/hello/scripts/poster-card.js`,
 * which is why the only type here is a JSDoc one: the contract is visible, and
 * the file still runs as-is in the Worker.
 */

/** The three characters an SVG text node cannot carry raw. */
const ESCAPE = /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })

/** @param {unknown} value */
function escapeText(value) {
  return String(value).replace(/[&<>]/g, (char) => ESCAPE[char] ?? char)
}

/** @type {import('@bffless/workflow-script').ScriptModule['default']} */
export default async function run(ctx) {
  ctx.log('drawing')

  const line = String(ctx.inputs.line ?? '')
  const counts = Array.isArray(ctx.inputs.counts) ? ctx.inputs.counts : []
  const subtitle = `${counts.length} line${counts.length === 1 ? '' : 's'} analyzed`

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="#101828"/>' +
    `<text x="320" y="176" fill="#ffffff" font-family="system-ui,sans-serif" font-size="34" text-anchor="middle">${escapeText(line)}</text>` +
    `<text x="320" y="224" fill="#98a2b3" font-family="system-ui,sans-serif" font-size="18" text-anchor="middle">${escapeText(subtitle)}</text>` +
    '</svg>'

  ctx.annotate({ level: 'notice', message: 'card drawn' })

  const poster = new File([svg], 'poster.svg', { type: 'image/svg+xml' })

  return {
    poster,
    // The same file again, as a `list: true` output: what the `images`
    // renderer draws its grid from, and the options list the `review` form's
    // tile picker offers (Phase 3). A `list` of `file` uploads every item, so
    // this is a second upload of the same bytes — deliberate, and cheap.
    posters: [poster],
    // Over the 256 KB budget on purpose: this is what the `{"$file"}` offload
    // (Decision 5) is for, end to end. 12 000 entries of `{ i, line, k }` is
    // ~480 KB *before* the line itself — `k` is a fixed marker that keeps the
    // headroom real (a one-character line was only 2.7 KB over without it,
    // apps#375; `src/hello-scripts.test.ts` pins the margin) — and it stays
    // as small as that, because the run page renders this.
    big: Array.from({ length: 12000 }, (_, i) => ({ i, line, k: 'offload-demo' })),
  }
}
