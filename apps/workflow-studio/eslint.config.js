import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output is not ours to lint.
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Islands run in a sandboxed opaque-origin iframe and scripts in a Worker on one —
    // neither can carry Studio's Redux store along for the ride, and `studio`'s `lib/*`
    // export is a wildcard over every module, four of which touch the store
    // (apps/studio/CLAUDE.md → "Public surface"). Fence those four out here rather than
    // relying on the doc alone (apps/workflow/eslint.config.js has the same shape for
    // `lib/runner`).
    files: ['scripts/**/*.ts', 'islands/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: [
            'studio/lib/projectSync', 'studio/lib/projects', 'studio/lib/transcriptText', 'studio/lib/studioRoute',
            'studio/store/*', 'react-redux', '@reduxjs/*',
          ],
            message: 'This module touches Studio\'s Redux store (apps/studio/CLAUDE.md → "Public surface") — not safe from scripts/ or islands/.' },
        ],
      }],
    },
  },
])
