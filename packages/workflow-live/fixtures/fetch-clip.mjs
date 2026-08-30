// One-time: pull the 2026-08-29 by-hand Studio run's input recording through the harness.
// usage: WORKFLOW_EMAIL=… WORKFLOW_PASSWORD=… node fetch-clip.mjs <out.mp4> [https://workflow.j5s.dev]
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
const [out, base = 'https://workflow.j5s.dev'] = process.argv.slice(2)
const PATH = '/api/uploads/workflows/workflow-studio/studio/inputs/c9b46c55-3a51-4abf-a966-e748bd0623e8-Onboarding_Rules.mp4'
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.goto(base + '/', { waitUntil: 'networkidle' })
await page.waitForURL(/\/login/, { timeout: 20_000 }).catch(() => {})
if (/\/login/.test(page.url())) {
  await page.fill('input[type="email"]', process.env.WORKFLOW_EMAIL)
  await page.fill('input[type="password"]', process.env.WORKFLOW_PASSWORD)
  await Promise.all([page.waitForURL((u) => u.origin === new URL(base).origin, { timeout: 30_000 }), page.locator('button[type="submit"]').first().click()])
}
const res = await page.request.get(base + PATH)
if (res.status() !== 200) { console.error('download failed', res.status()); process.exit(1) }
writeFileSync(out, await res.body())
console.log(out)
await browser.close()
