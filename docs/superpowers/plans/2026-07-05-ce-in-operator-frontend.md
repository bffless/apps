# CE Admin Frontend — `in` Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CE admin pipeline editor render and edit the new `in` filter operator across the `data_query`, `db_aggregate`, and `data_update` step config forms, with a value input that supports both an expression (resolves to an array at runtime) and a literal comma-separated list.

**Architecture:** Three React config components each render a filter row (field picker + operator `<Select>` + `ExpressionInput` value). They hydrate local `FilterEntry` state from `config.filters` and write it back via a `useEffect` `onChange`. We add `in` to each operator list and route the value through a shared pure helper that disambiguates by comma: `in` + comma → `string[]` (literal list); otherwise the raw string (preserves expressions like `steps.prep.urls`, which never contain commas, and single literals, which the backend wraps into a one-element array).

**Tech Stack:** React 18 + TypeScript, shadcn/Radix UI, Vitest + @testing-library/react + user-event. Run from `repos/ce/apps/frontend`.

## Global Constraints

- Repo/dir: `/home/rico/bffless/repos/ce/apps/frontend`. You are on branch `reader-in-operator` (same branch as the CE backend `in` work) — do NOT switch branches.
- **The comma rule is the correctness crux:** for `op === 'in'`, a value **containing a comma** serializes to a trimmed `string[]`; a value with **no comma** stays a `string`. This preserves runtime expressions (`steps.folderFeeds.urls` — no comma → stays a string the backend evaluator resolves to an array) and single literals (no comma → string → backend wraps to a one-element `IN`). Never unconditionally split (`"steps.prep.urls".split(',')` → `["steps.prep.urls"]` would stop the backend from resolving the expression).
- For every operator OTHER than `in`, value serialization is unchanged (always the raw string).
- On hydrate, an existing array value must render as a comma-joined string (`["a","b"]` → `"a, b"`) so it displays and round-trips.
- Config output types widen to `string | string[]`; the editable `FilterEntry.value` stays `string`.
- Do not change behavior of existing operators or other config fields. Existing config-component tests must stay green.
- Test runner is Vitest. Run focused: `pnpm exec vitest run <path-or-substring>` from `repos/ce/apps/frontend`. Mirror the existing house test harness in `src/components/pipelines/handlers/FileServeHandlerConfig.test.tsx` (controlled `Harness` that feeds `onChange` back into `config`; assert via `@testing-library` queries and `vi.fn()` onChange). Do NOT drive the Radix operator `<Select>` in jsdom — assert the data round-trip via an initial `config` and the plain `ExpressionInput` value field instead.

---

### Task 1: Shared filter-value helper + type widening

**Files:**
- Create: `repos/ce/apps/frontend/src/components/pipelines/handlers/filter-value.ts`
- Create: `repos/ce/apps/frontend/src/components/pipelines/handlers/filter-value.test.ts`
- Modify: `repos/ce/apps/frontend/src/components/pipelines/handlers/types.ts` (`FilterConfig` op union + value type ~61-64; `DataUpdateHandlerConfig.filters` ~85)

**Interfaces:**
- Produces:
  - `serializeFilterValue(op: string, text: string): string | string[]` — for `op === 'in'` with a comma in `text`, returns `text.split(',').map(s => s.trim()).filter(Boolean)`; otherwise returns `text` unchanged.
  - `displayFilterValue(value: string | string[] | undefined): string` — array → `value.join(', ')`; string → itself; nullish → `''`.
- Consumed by Tasks 2, 3, 4 (all three config components).

- [ ] **Step 1: Write the failing helper test**

Create `src/components/pipelines/handlers/filter-value.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serializeFilterValue, displayFilterValue } from './filter-value';

describe('serializeFilterValue', () => {
  it('splits an in value with commas into a trimmed array', () => {
    expect(serializeFilterValue('in', 'a.com, b.com ,c.com')).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('keeps an in value with no comma as a string (preserves expressions)', () => {
    expect(serializeFilterValue('in', 'steps.folderFeeds.urls')).toBe('steps.folderFeeds.urls');
  });

  it('keeps a single literal in value as a string', () => {
    expect(serializeFilterValue('in', 'only.com')).toBe('only.com');
  });

  it('drops empty segments from an in list', () => {
    expect(serializeFilterValue('in', 'a.com, , b.com,')).toEqual(['a.com', 'b.com']);
  });

  it('never splits non-in operators, even with commas', () => {
    expect(serializeFilterValue('eq', 'a, b')).toBe('a, b');
    expect(serializeFilterValue('like', '%x, y%')).toBe('%x, y%');
  });
});

describe('displayFilterValue', () => {
  it('joins an array with comma-space', () => {
    expect(displayFilterValue(['a', 'b'])).toBe('a, b');
  });

  it('passes a string through', () => {
    expect(displayFilterValue('steps.x.urls')).toBe('steps.x.urls');
  });

  it('renders nullish as empty string', () => {
    expect(displayFilterValue(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/components/pipelines/handlers/filter-value.test.ts`
Expected: FAIL — cannot find module `./filter-value`.

- [ ] **Step 3: Implement the helper**

Create `src/components/pipelines/handlers/filter-value.ts`:

```ts
/**
 * Serialize a filter row's editable text into the stored config value.
 *
 * For the `in` operator a comma-separated string becomes a trimmed string[]
 * (a literal list). A value with no comma is left as a string so runtime
 * expressions (e.g. `steps.folderFeeds.urls`, which never contain commas) are
 * resolved to an array by the backend evaluator, and a single literal is wrapped
 * into a one-element IN by the backend. Every other operator is unchanged.
 */
export function serializeFilterValue(op: string, text: string): string | string[] {
  if (op === 'in' && text.includes(',')) {
    return text.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return text;
}

/** Render a stored filter value (string or array) as editable text. */
export function displayFilterValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run src/components/pipelines/handlers/filter-value.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Widen the config types**

In `src/components/pipelines/handlers/types.ts`, change `FilterConfig` (lines ~61-64) to:

```ts
export interface FilterConfig {
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'like' | 'in';
  value: string | string[];
}
```

And change `DataUpdateHandlerConfig.filters` (line ~85) to:

```ts
  filters?: Record<string, { op: 'eq' | 'ne' | 'in'; value: string | string[] }>;
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: MAY surface errors in `DataQueryConfig.tsx` / `DbAggregateConfig.tsx` / `DataUpdateConfig.tsx` where `FilterEntry.value` (typed `string`) is assigned from `conf.value` (now `string | string[]`). That is expected — Tasks 2-4 fix each call site with `displayFilterValue`. If you see ONLY those three call-site errors, that confirms the type widened correctly; proceed. (Do not fix those files in this task.)

- [ ] **Step 7: Commit**

```bash
cd /home/rico/bffless/repos/ce/apps/frontend
git add src/components/pipelines/handlers/filter-value.ts src/components/pipelines/handlers/filter-value.test.ts src/components/pipelines/handlers/types.ts
git commit -m "feat(frontend): filter-value helper + in operator types"
```

---

### Task 2: `data_query` config editor

**Files:**
- Modify: `repos/ce/apps/frontend/src/components/pipelines/handlers/DataQueryConfig.tsx` (`FILTER_OPS` ~33-41; hydrate map ~51; save loop ~65)
- Create: `repos/ce/apps/frontend/src/components/pipelines/handlers/DataQueryConfig.test.tsx`

**Interfaces:**
- Consumes: `serializeFilterValue`, `displayFilterValue` from Task 1.

- [ ] **Step 1: Write the failing test**

Create `src/components/pipelines/handlers/DataQueryConfig.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataQueryConfig } from './DataQueryConfig';

// SchemaPicker/SchemaFieldPicker hit data services; stub them to plain inputs so
// this test stays focused on filter value (de)serialization.
vi.mock('./SchemaPicker', () => ({ SchemaPicker: () => null }));
vi.mock('./SchemaFieldPicker', () => ({
  SchemaFieldPicker: ({ value }: { value: string }) => <div data-testid="field">{value}</div>,
}));

describe('DataQueryConfig in operator', () => {
  it('hydrates an array in-filter as a comma-joined value and round-trips it back to an array', () => {
    const onChange = vi.fn();
    render(
      <DataQueryConfig
        projectId="p1"
        config={{ schemaId: 's1', filters: { feedId: { op: 'in', value: ['https://a.com/feed', 'https://b.com/feed'] } } }}
        onChange={onChange}
      />,
    );

    // Displayed as comma-joined text in the value input.
    expect(screen.getByDisplayValue('https://a.com/feed, https://b.com/feed')).toBeInTheDocument();

    // The mount effect emits the config with the value re-serialized to an array.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { feedId: { op: 'in', value: ['https://a.com/feed', 'https://b.com/feed'] } },
      }),
    );
  });

  it('keeps an expression in-value (no comma) as a string', () => {
    const onChange = vi.fn();
    render(
      <DataQueryConfig
        projectId="p1"
        config={{ schemaId: 's1', filters: { feedId: { op: 'in', value: 'steps.prep.urls' } } }}
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { feedId: { op: 'in', value: 'steps.prep.urls' } },
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/components/pipelines/handlers/DataQueryConfig.test.tsx`
Expected: FAIL — hydrate passes the raw array to `ExpressionInput` (renders `"https://a.com/feed,https://b.com/feed"`, no space) and the save loop emits the array unchanged only by accident; the expression case fails because nothing coerces. (Exact failure may vary; the point is RED before the edits.)

- [ ] **Step 3: Add `in` to the operator list**

In `DataQueryConfig.tsx`, add one entry at the end of `FILTER_OPS` (after `like`, ~line 40):

```ts
  { value: 'like', label: 'Like (pattern)' },
  { value: 'in', label: 'In (any of)' },
];
```

- [ ] **Step 4: Import the helpers**

Add after the existing type import (~line 18):

```ts
import { serializeFilterValue, displayFilterValue } from './filter-value';
```

- [ ] **Step 5: Use `displayFilterValue` on hydrate**

Change the hydrate map (~line 51) from `value: conf.value` to `value: displayFilterValue(conf.value)`:

```ts
      ? entries.map(([field, conf]) => ({ field, op: conf.op, value: displayFilterValue(conf.value) }))
```

- [ ] **Step 6: Use `serializeFilterValue` on save**

In the `useEffect` save loop (~line 65), change:

```ts
        filtersRecord[filter.field.trim()] = { op: filter.op, value: serializeFilterValue(filter.op, filter.value) };
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm exec vitest run src/components/pipelines/handlers/DataQueryConfig.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
cd /home/rico/bffless/repos/ce/apps/frontend
git add src/components/pipelines/handlers/DataQueryConfig.tsx src/components/pipelines/handlers/DataQueryConfig.test.tsx
git commit -m "feat(frontend): in operator in data_query config editor"
```

---

### Task 3: `db_aggregate` config editor

**Files:**
- Modify: `repos/ce/apps/frontend/src/components/pipelines/handlers/DbAggregateConfig.tsx` (`FILTER_OPS` ~45-53; hydrate map; save loop) — this component mirrors `DataQueryConfig.tsx` structurally.
- Create: `repos/ce/apps/frontend/src/components/pipelines/handlers/DbAggregateConfig.test.tsx`

**Interfaces:**
- Consumes: `serializeFilterValue`, `displayFilterValue` from Task 1.

- [ ] **Step 1: Read the component**

Read `DbAggregateConfig.tsx` and locate its three edit points (they mirror `DataQueryConfig`): the `FILTER_OPS` array, the `config.filters` hydrate `.map(...)` (`value: conf.value`), and the `useEffect` loop that builds `filtersRecord[...] = { op: filter.op, value: filter.value }`.

- [ ] **Step 2: Write the failing test**

Create `src/components/pipelines/handlers/DbAggregateConfig.test.tsx`, mirroring Task 2's test but importing `DbAggregateConfig`. Use an aggregate-appropriate config (include whatever required props the component needs — at minimum `projectId`, `schemaId`, and a count `operation` if the component requires it; read the component to confirm required fields). The two assertions are identical in spirit:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DbAggregateConfig } from './DbAggregateConfig';

vi.mock('./SchemaPicker', () => ({ SchemaPicker: () => null }));
vi.mock('./SchemaFieldPicker', () => ({
  SchemaFieldPicker: ({ value }: { value: string }) => <div data-testid="field">{value}</div>,
}));

describe('DbAggregateConfig in operator', () => {
  it('hydrates an array in-filter as comma-joined text and round-trips to an array', () => {
    const onChange = vi.fn();
    render(
      <DbAggregateConfig
        projectId="p1"
        config={{ schemaId: 's1', operation: 'count', filters: { feedId: { op: 'in', value: ['a', 'b'] } } }}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('a, b')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { feedId: { op: 'in', value: ['a', 'b'] } } }),
    );
  });

  it('keeps an expression in-value as a string', () => {
    const onChange = vi.fn();
    render(
      <DbAggregateConfig
        projectId="p1"
        config={{ schemaId: 's1', operation: 'count', filters: { feedId: { op: 'in', value: 'steps.prep.urls' } } }}
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { feedId: { op: 'in', value: 'steps.prep.urls' } } }),
    );
  });
});
```

If the component requires additional props/config fields to render (verify by reading it), add them to both `config` objects so the component mounts.

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run src/components/pipelines/handlers/DbAggregateConfig.test.tsx`
Expected: FAIL (same reason as Task 2).

- [ ] **Step 4: Apply the three edits (mirror Task 2)**

1. Add `{ value: 'in', label: 'In (any of)' }` to the end of `FILTER_OPS`.
2. Add `import { serializeFilterValue, displayFilterValue } from './filter-value';`.
3. Hydrate map: `value: displayFilterValue(conf.value)`.
4. Save loop: `value: serializeFilterValue(filter.op, filter.value)`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run src/components/pipelines/handlers/DbAggregateConfig.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/rico/bffless/repos/ce/apps/frontend
git add src/components/pipelines/handlers/DbAggregateConfig.tsx src/components/pipelines/handlers/DbAggregateConfig.test.tsx
git commit -m "feat(frontend): in operator in db_aggregate config editor"
```

---

### Task 4: `data_update` config editor (inline eq/ne → add in)

**Files:**
- Modify: `repos/ce/apps/frontend/src/components/pipelines/handlers/DataUpdateConfig.tsx` (`FilterEntry.op` ~29; hydrate default ~47; save record type ~59; `onValueChange` cast ~173; `<SelectContent>` ~179-182; hydrate map ~46; save loop ~62)
- Create: `repos/ce/apps/frontend/src/components/pipelines/handlers/DataUpdateConfig.test.tsx`

**Interfaces:**
- Consumes: `serializeFilterValue`, `displayFilterValue` from Task 1.

- [ ] **Step 1: Write the failing test**

Create `src/components/pipelines/handlers/DataUpdateConfig.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataUpdateConfig } from './DataUpdateConfig';

vi.mock('./SchemaPicker', () => ({ SchemaPicker: () => null }));
vi.mock('./SchemaFieldPicker', () => ({
  SchemaFieldPicker: ({ value }: { value: string }) => <div data-testid="field">{value}</div>,
}));

describe('DataUpdateConfig in operator', () => {
  it('hydrates an array in-filter as comma-joined text and round-trips to an array', () => {
    const onChange = vi.fn();
    render(
      <DataUpdateConfig
        projectId="p1"
        config={{
          schemaId: 's1',
          filters: { feedId: { op: 'in', value: ['a', 'b'] } },
          fields: { read: 'true' },
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('a, b')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { feedId: { op: 'in', value: ['a', 'b'] } } }),
    );
  });

  it('keeps an expression in-value as a string', () => {
    const onChange = vi.fn();
    render(
      <DataUpdateConfig
        projectId="p1"
        config={{
          schemaId: 's1',
          filters: { feedId: { op: 'in', value: 'steps.prep.urls' } },
          fields: { read: 'true' },
        }}
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { feedId: { op: 'in', value: 'steps.prep.urls' } } }),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/components/pipelines/handlers/DataUpdateConfig.test.tsx`
Expected: FAIL — the inline `op: 'eq' | 'ne'` types reject `'in'` at compile time and the hydrate/save don't handle arrays.

- [ ] **Step 3: Widen the inline op unions**

In `DataUpdateConfig.tsx`:
- `FilterEntry` interface (~line 29): `op: 'eq' | 'ne' | 'in';`
- The `filtersRecord` type in the save `useEffect` (~line 59): `const filtersRecord: Record<string, { op: 'eq' | 'ne' | 'in'; value: string | string[] }> = {};`
- The `<Select>` `onValueChange` cast (~line 173): `handleFilterChange(index, { op: value as 'eq' | 'ne' | 'in' })`

- [ ] **Step 4: Add the `in` option to the dropdown**

In the `<SelectContent>` (~lines 179-182), add the item:

```tsx
                <SelectContent>
                  <SelectItem value="eq">Equals</SelectItem>
                  <SelectItem value="ne">Not Equals</SelectItem>
                  <SelectItem value="in">In (any of)</SelectItem>
                </SelectContent>
```

- [ ] **Step 5: Import helpers + wire hydrate/save**

- Add `import { serializeFilterValue, displayFilterValue } from './filter-value';` near the other imports.
- Hydrate map (~line 46): `value: displayFilterValue(conf.value)`.
- Save loop (~line 62): `filtersRecord[filter.field.trim()] = { op: filter.op, value: serializeFilterValue(filter.op, filter.value) };`

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm exec vitest run src/components/pipelines/handlers/DataUpdateConfig.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
cd /home/rico/bffless/repos/ce/apps/frontend
git add src/components/pipelines/handlers/DataUpdateConfig.tsx src/components/pipelines/handlers/DataUpdateConfig.test.tsx
git commit -m "feat(frontend): in operator in data_update config editor"
```

---

### Task 5: Typecheck + build gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole frontend**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (All three `FilterEntry.value` call sites now go through `displayFilterValue`; the widened config types resolve cleanly.)

- [ ] **Step 2: Run the four new specs + a sanity of the existing handler tests**

Run: `pnpm exec vitest run src/components/pipelines/handlers`
Expected: PASS — the 4 new specs (`filter-value`, `DataQueryConfig`, `DbAggregateConfig`, `DataUpdateConfig`) plus the pre-existing handler config tests (`FileServeHandlerConfig`, `FileDeleteHandlerConfig`, `XmlFeedParseConfig`) are all green.

- [ ] **Step 3: Production build**

Run: `pnpm build`
Expected: exit 0 (Vite/tsc build succeeds).

- [ ] **Step 4: Commit any lint/format fixups (if any)**

```bash
cd /home/rico/bffless/repos/ce/apps/frontend
git add -A && git commit -m "chore(frontend): lint/format for in operator" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage** — user requirement: "the UI can render the pipeline as it exists and make edits, and allow selecting this operator." Task 1 provides the value (de)serialization + widened types; Tasks 2-4 add `in` to each of the three step editors' operator pickers (render + selectable) and route hydrate/save through the helper (renders existing `in` filters, edits without corruption). Task 5 gates typecheck + build. The `data_delete` editor and the separate data-browser (`DataFilters.tsx`) are intentionally out of scope (the backend `in` change did not touch `data_delete`, and the data browser is a different feature) — noted here so a reviewer doesn't flag them as gaps.

**Placeholder scan** — every step has concrete code, a command, and an expected result. The one "read the component" step (Task 3 Step 1) is a genuine inspection step for a structurally-identical file, with the exact edits enumerated in Step 4.

**Type consistency** — `serializeFilterValue(op, text)` and `displayFilterValue(value)` signatures are identical across Tasks 2-4; config value types are `string | string[]` in both `FilterConfig` and the `data_update` inline union; `FilterEntry.value` stays `string` in all three components.

## Downstream / follow-ups

- Minor doc-comment drift in the CE backend handlers (from Plan 1's review) — optional cleanup, unrelated to the frontend.
- A literal-list value that a user *intends* as one comma-containing string (rare) would be split; acceptable given `in` semantics. Documented for the final review.
