/**
 * hello's `script` step (03): draw a poster for the line the island picked.
 *
 * Copied verbatim into the bundle by `scripts/stage-hello.mjs` — no build, no
 * imports — and fetched by the harness from `/w/hello/scripts/poster-card.js`,
 * which is why the only type here is a JSDoc one: the contract is visible, and
 * the file still runs as-is in the Worker.
 */

/** The three characters an SVG text node cannot carry raw. */
const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

function escapeText(value) {
  return String(value).replace(/[&<>]/g, (char) => ESCAPE[char])
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

  return {
    poster: new File([svg], 'poster.svg', { type: 'image/svg+xml' }),
    // Over the 256 KB budget on purpose: this is what the `{"$file"}` offload
    // (Decision 5) is for, end to end. 12 000 entries is ~250 KB of `{i,line}`
    // pairs *before* the line itself, so any non-empty line clears the budget —
    // and it is as small as that can be, because the run page renders this.
    big: Array.from({ length: 12000 }, (_, i) => ({ i, line })),
  }
}
