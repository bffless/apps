/**
 * The `uplot` module stub every suite that renders a `render: chart` output
 * needs. jsdom has no canvas backend (`src/test/setup.ts` stubs enough of one
 * to keep uPlot's draw path from a null deref), and no unit test here asserts
 * pixels — so the suites that only need "`render: chart` reached `ChartView`"
 * replace the module outright instead. That stub was copied into three test
 * files before apps#380; this is the one copy.
 *
 * `vi.mock`'s factory is hoisted above the imports, so it cannot close over an
 * ordinary top-level import. Pull it in from inside an async factory instead:
 *
 * ```ts
 * vi.mock('uplot', async () => (await import('../../test/uplotMock')).inertUPlot())
 * ```
 *
 * A suite that needs to *assert* on the constructor (`ChartView.test.tsx`)
 * keeps its own `vi.hoisted` spies — this stub is deliberately inert.
 */

/** The module shape `import uPlot from 'uplot'` expects, drawing nothing. */
export function inertUPlot(): { default: unknown } {
  class MockUPlot {
    static paths = { bars: () => undefined }
    destroy() {}
  }
  return { default: MockUPlot }
}
