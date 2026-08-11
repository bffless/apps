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
    trace: 'retain-on-failure',
  },
})
