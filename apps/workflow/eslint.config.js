import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build/coverage output and the MSW-generated worker are not ours to lint.
  globalIgnores(['dist', 'coverage', 'public/mockServiceWorker.js']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // The hello bundle's `script` step modules: plain JS run in a Worker, copied
    // verbatim by the stager — linted here, type-checked by `tsconfig.scripts.json`
    // (apps#375).
    files: ['hello/scripts/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.worker,
    },
  },
  {
    files: ['src/lib/runner/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          // The relative groups are repeated one level deeper so the fence also
          // covers `lib/runner/adapters/*` — a pattern is matched against the
          // specifier as written, not against the resolved path.
          { group: ['react', 'react-*', '@reduxjs/*', 'react-redux', 'msw*',
            '../../store/*', '../../components/*', '../../pages/*', '../../mocks/*',
            '../../islands/*', '../../scripts/*',
            '../../../store/*', '../../../components/*', '../../../pages/*', '../../../mocks/*',
            '../../../islands/*', '../../../scripts/*'],
            message: 'lib/runner is pure (spec 09): no React, Redux, MSW, islands, scripts, or app modules.' },
        ],
      }],
    },
  },
])
