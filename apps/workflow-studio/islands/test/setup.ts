/**
 * Setup for the `islands` vitest project: jest-dom's matchers (`toBeVisible`,
 * `toHaveTextContent`, …) on Vitest's `expect`. The project runs with
 * `globals: true`, so the `/vitest` entry point is the right one — it registers
 * against the global `expect` rather than needing an explicit `expect.extend`.
 */
import '@testing-library/jest-dom/vitest'
