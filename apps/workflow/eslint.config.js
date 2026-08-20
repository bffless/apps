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
    files: ['src/lib/runner/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          // The relative groups are repeated one level deeper so the fence also
          // covers `lib/runner/adapters/*` — a pattern is matched against the
          // specifier as written, not against the resolved path.
          { group: ['react', 'react-*', '@reduxjs/*', 'react-redux', 'msw*',
            '../../store/*', '../../components/*', '../../pages/*', '../../mocks/*',
            '../../../store/*', '../../../components/*', '../../../pages/*', '../../../mocks/*'],
            message: 'lib/runner is pure (spec 09): no React, Redux, MSW, or app modules.' },
        ],
      }],
    },
  },
])
