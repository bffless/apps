import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './src',
  testMatch: '**/run.spec.ts',
  timeout: 0, // per-phase expect timeouts govern; the CI job timeout is the backstop
  retries: 0, // a retry re-spends real AI credits — never
  workers: 1,
  outputDir: './output',
  reporter: [['list'], ['json', { outputFile: 'output/report.json' }]],
  use: {
    ...devices['Desktop Firefox'],
    browserName: 'firefox',
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
    launchOptions: {
      firefoxUserPrefs:
        // Default OFF: disabling SharedArrayBuffer makes the page report
        // crossOriginIsolated=false, so Studio itself falls back to its
        // single-threaded ffmpeg core. The MT core loaded and then hung
        // indefinitely on the first exec in headless CI Firefox (run
        // 31547724192: 34 min of silence after "core: multithreaded");
        // ST is slower per-encode but completes. Set FFMPEG_MT=true to
        // re-try the multithreaded core.
        process.env.FFMPEG_MT === 'true' ? {} : { 'javascript.options.shared_memory': false },
    },
  },
})
