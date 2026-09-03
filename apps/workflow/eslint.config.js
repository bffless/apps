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
  // The MCP rules' shared `*.fn.js` bundles (scripts/build-mcp.mjs, under mcp-fn/) —
  // generated, and carrying their sources' own eslint directives verbatim.
  globalIgnores(['dist', 'coverage', 'public/mockServiceWorker.js', 'hello-src', 'hello-dist', '.bffless/proxy-rules/workflow/mcp-fn/*.fn.js']),
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
  {
    // The agent layer binds the catalog to the store (spec 10, D19/D21): it may
    // import `@bffless/workflow-agent-tools`, `../store/*`, the lib modules the
    // page itself reads from (`workflowGlobal`, `autoStart`, `describe`,
    // `coerce`) and `islands/hostDeps` (the one browser capability — signing —
    // it shares with islands). Never the engine, a component, a page or the
    // mocks: the agent does what a click does; it does not reach past the click.
    files: ['src/agent/**/*.{ts,tsx}'],
    ignores: ['src/agent/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['../lib/runner/*', '../lib/runner/**', '../components/*', '../components/**',
            '../pages/*', '../pages/**', '../islands/*', '!../islands/hostDeps', '../mocks/*', '../scripts/*'],
            message: 'src/agent imports the catalog package, ../store/*, lib/{workflowGlobal,autoStart,describe,coerce} and islands/hostDeps only (spec 10, D19).' },
        ],
      }],
    },
  },
  {
    // The MCP endpoint's function sources (spec 10, D22; Phase 2 plan, Decision 1)
    // are bundled by scripts/build-mcp.mjs into CE function_handler code that
    // runs in a vm sandbox with no DOM, no store and no fetch. They may import
    // the catalog package, workflow-lint's definition model, `yaml`,
    // lib/describe, the pure island/declared adapters and the runner types —
    // never the island host itself (it would drag the ext-apps bridge into the
    // sandbox). Anything React-, Redux- or DOM-shaped would either break the
    // bundle or bloat it.
    files: ['src/mcp/**/*.ts'],
    ignores: ['src/mcp/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['react', 'react-*', '@reduxjs/*', 'react-redux', 'msw*',
            '../store/*', '../store/**', '../components/*', '../components/**', '../pages/*', '../pages/**',
            '../mocks/*', '../mocks/**', '../scripts/*', '../scripts/**', '../agent/*', '../agent/**',
            '../islands/*', '../islands/**',
            '../lib/*', '!../lib/describe', '!../lib/runner',
            '../lib/runner/*', '!../lib/runner/adapters', '!../lib/runner/types',
            '../lib/runner/adapters/*', '!../lib/runner/adapters/island', '!../lib/runner/adapters/declared'],
            message: 'src/mcp is bundled into a CE function_handler (spec 10, D22): only the catalog package, @bffless/workflow-lint/definition, yaml, lib/describe, lib/runner/{adapters/island,adapters/declared,types} may be imported.' },
        ],
      }],
    },
  },
])
