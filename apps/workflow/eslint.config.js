import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build/coverage output, the MSW-generated worker, and the staged clone of
  // `bffless/workflow-implementations` (`hello-src/` — that repo lints its own
  // sources, and its `workflows/workflow-studio` tsconfig would confuse the
  // typed parser here) are not ours to lint.
  globalIgnores(['dist', 'coverage', 'public/mockServiceWorker.js', 'hello-src', 'hello-dist']),
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
