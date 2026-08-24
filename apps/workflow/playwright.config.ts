import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  use: { baseURL: 'http://localhost:4680' },
  webServer: {
    command: 'pnpm dev --port 4680 --strictPort',
    url: 'http://localhost:4680',
    reuseExistingServer: !process.env.CI,
  },
})
