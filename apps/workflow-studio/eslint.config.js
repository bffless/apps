import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output is not ours to lint.
  globalIgnores(['dist', 'coverage']),
  {
    // `.mjs` is here for the stager (`scripts/stage.mjs`): it is real, shipped code — the
    // thing CI and the deploy both run — and was going unlinted while every other file in
    // the app was checked.
    files: ['**/*.{ts,tsx,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // …but the stager is Node, not a browser: `process`, `console` and friends come from
    // there. Scoped to `scripts/*.mjs` so the browser/Worker globals above stay the default
    // for everything else in `scripts/` (which is TypeScript, and runs in a Worker).
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // The islands are React, and the rules of hooks are not optional in a component
    // that owns a `workflow.submit` (a stale closure there submits the wrong cuts).
    // Same plugin + preset `apps/studio` lints its own components with.
    files: ['islands/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
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
