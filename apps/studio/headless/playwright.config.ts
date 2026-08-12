import { defineConfig, devices } from '@playwright/test'

// RUNNER_BROWSER=chrome runs Google Chrome stable (preinstalled on
// ubuntu-latest; `playwright install chrome` elsewhere) instead of Playwright's
// Firefox. Chrome carries the H.264/AAC codecs like Firefox+system-ffmpeg does,
// and is the experiment platform for the multithreaded ffmpeg core — MT hangs
// its first exec in headless Firefox, and wasm threads are far better exercised
// in headless Chromium.
const chrome = process.env.RUNNER_BROWSER === 'chrome'

export default defineConfig({
  testDir: './src',
  testMatch: '**/run.spec.ts',
  timeout: 0, // per-phase expect timeouts govern; the CI job timeout is the backstop
  retries: 0, // a retry re-spends real AI credits — never
  workers: 1,
  outputDir: './output',
  reporter: [['list'], ['json', { outputFile: 'output/report.json' }]],
  use: {
    ...(chrome
      ? { ...devices['Desktop Chrome'], channel: 'chrome' as const }
      : { ...devices['Desktop Firefox'], browserName: 'firefox' as const }),
    viewport: { width: 1440, height: 900 },
    // Real-run traces would record page.fill() action params (the literal
    // STUDIO_USER_EMAIL/STUDIO_USER_PASSWORD) and the real-run workflow
    // uploads output/ wholesale on a public repo — never trace real mode.
    trace: process.env.MOCK_MODE === 'true' ? 'retain-on-failure' : 'off',
    // Bounds individual clicks/fills (the live-unverified admin-login
    // selectors included) so a locator mismatch fails in ~2 min instead of
    // hanging until the job is killed at timeout-minutes; explicit expect
    // waits still govern the long phases (prep/director/build).
    actionTimeout: 120_000,
    // NOTE: do not "force ST" by disabling shared memory via firefoxUserPrefs —
    // the javascript.options.shared_memory=false pref makes Firefox's wasm
    // validator reject BOTH cores (even the single-threaded build carries
    // atomics opcodes; run 31550836845). The runner instead lands on
    // ?ffmpegCore=st, an explicit app-side override.
  },
})
