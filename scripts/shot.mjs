#!/usr/bin/env node
// Screenshot + smoke-check helper for the bffless-apps Vite SPAs (handoff, studio),
// which proxy /api + /_bffless to live j5s.dev.
//
// Vendored from the workspace's localdev-tools/shot.mjs so it travels into the
// Sandcastle sandbox worktree. The agent uses it to verify visual changes: start
// the app's dev server, screenshot the relevant page(s), and confirm the page has
// no console errors / failed requests (it exits non-zero on either, so it doubles
// as a smoke test).
//
// Usage:
//   node scripts/shot.mjs <url> [--out file.png] [--width 1280] [--height 800]
//                               [--full] [--wait selector] [--mobile] [--dark]
//
// Examples:
//   node scripts/shot.mjs http://localhost:5173/ --out .sandcastle/screenshots/home.png --full
//   node scripts/shot.mjs http://localhost:5173/viewer --wait "[data-node]" --mobile
//
// Always prints any console errors and failed/4xx-5xx network requests to stderr,
// then a one-line JSON summary to stdout.

import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
const url = args.find((a) => !a.startsWith('--'))
if (!url) {
  console.error('Usage: node scripts/shot.mjs <url> [--out f.png] [--full] [--wait sel] [--width N] [--height N] [--mobile] [--dark]')
  process.exit(2)
}
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return def
  const next = args[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const out = flag('out', `.sandcastle/screenshots/shot-${Date.now()}.png`)
const width = Number(flag('width', flag('mobile', false) ? 390 : 1280))
const height = Number(flag('height', flag('mobile', false) ? 844 : 800))
const fullPage = Boolean(flag('full', false))
const waitSel = flag('wait', null)

mkdirSync(dirname(out), { recursive: true })

// --no-sandbox is required when running Chromium as a non-root user inside a
// container (the Sandcastle sandbox); --disable-dev-shm-usage avoids crashes from
// the small default /dev/shm in containers.
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2,
  isMobile: Boolean(flag('mobile', false)),
  colorScheme: flag('dark', false) ? 'dark' : 'light',
})
const page = await context.newPage()

const consoleErrors = []
const failedRequests = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
page.on('requestfailed', (req) =>
  failedRequests.push({ url: req.url(), error: req.failure()?.errorText }))
page.on('response', (res) => {
  if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status() })
})

let navOk = true
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
  if (typeof waitSel === 'string') await page.waitForSelector(waitSel, { timeout: 15000 })
} catch (err) {
  navOk = false
  console.error(`NAV ERROR: ${err.message}`)
}

await page.screenshot({ path: out, fullPage })
await browser.close()

if (consoleErrors.length) console.error('CONSOLE ERRORS:\n  ' + consoleErrors.join('\n  '))
if (failedRequests.length)
  console.error('FAILED REQUESTS:\n  ' + failedRequests.map((r) => JSON.stringify(r)).join('\n  '))

console.log(JSON.stringify({ url, out, width, height, fullPage, navOk, consoleErrors: consoleErrors.length, failedRequests: failedRequests.length }))
process.exit(navOk && !consoleErrors.length && !failedRequests.length ? 0 : 1)
