# CE `in` Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `in` (array-membership) filter operator to CE's pipeline data handlers so a folder view can query/count/update items whose `feedId` is one of N feed URLs in a single query.

**Architecture:** Three data handlers (`data_query`, `db_aggregate`, `data_update`) each build a Drizzle `WHERE` from a `filters` map via a `switch (filter.op)`. We add a `case 'in'` that treats the expression-resolved value as an array and emits a parameterized `<jsonb field> IN (v1, v2, …)`, plus `'in'` in each `validateConfig` whitelist and each config `op` union. Empty arrays compile to a match-nothing predicate.

**Tech Stack:** NestJS, Drizzle ORM (`drizzle-orm`), PostgreSQL (JSONB `->>` text accessors), Jest. Handlers import `db` directly from `../../db/client`; unit tests mock that module and assert generated SQL via `PgDialect().sqlToQuery()`.

## Global Constraints

- Repo: `repos/ce`; backend package: `repos/ce/apps/backend`. Run all commands from `repos/ce/apps/backend`.
- The `in` value is expression-resolved and MUST be treated as an array — do NOT wrap it in `String()`/`Number()` (that is the coercion bug the spec calls out).
- Empty array → emit `sql\`false\`` (never `IN ()`, which is invalid Postgres).
- JSONB field values are text (`data->>'field'`), so `in` compares against string elements — map each element with `String(el)`.
- Do not change existing operator behavior (`eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `like`); all existing tests must stay green.
- Test framework: Jest via `pnpm test`. Match the existing house mock pattern in `src/pipelines/handlers/data-delete.handler.spec.ts` (thenable chainable `db` mock, `PgDialect` SQL rendering).

---

### Task 1: Shared `in` predicate helper + `data_query` support

**Files:**
- Create: `repos/ce/apps/backend/src/pipelines/handlers/in-filter.util.ts`
- Modify: `repos/ce/apps/backend/src/pipelines/handlers/data-query.handler.ts` (whitelist line ~60; switch lines ~131–153)
- Modify: `repos/ce/apps/backend/src/pipelines/execution/step-handler.interface.ts` (`DataQueryHandlerConfig.filters` op union ~87)
- Create: `repos/ce/apps/backend/src/pipelines/handlers/in-filter.util.spec.ts`
- Modify (test): `repos/ce/apps/backend/src/pipelines/handlers/data-query.handler.spec.ts` — create if absent

**Interfaces:**
- Produces: `buildInPredicate(fieldPath: SQL, value: unknown): SQL` — returns a Drizzle `SQL` predicate. `value` is coerced to an array (a non-array becomes a single-element array; `null`/`undefined` → empty). Empty array returns `sql\`false\``. Non-empty returns `sql\`${fieldPath} IN (${el1}, ${el2}, …)\`` with each element bound as `String(el)`.
- Consumes (in handlers): the existing `fieldPath = sql\`${pipelineData.data}->>'field'\`` expression and the expression-resolved `value`.

- [ ] **Step 1: Write the failing helper test**

Create `src/pipelines/handlers/in-filter.util.spec.ts`:

```ts
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { pipelineData } from '../../db/schema';
import { buildInPredicate } from './in-filter.util';

function render(pred: ReturnType<typeof buildInPredicate>) {
  return new PgDialect().sqlToQuery(pred);
}

const fieldPath = sql`${pipelineData.data}->>${sql.raw(`'feedId'`)}`;

describe('buildInPredicate', () => {
  it('emits a parameterized IN list for a non-empty array', () => {
    const { sql: text, params } = render(buildInPredicate(fieldPath, ['a', 'b']));
    expect(text).toContain('in (');
    expect(params).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('binds every element as text', () => {
    const { params } = render(buildInPredicate(fieldPath, [1, 2]));
    expect(params).toEqual(expect.arrayContaining(['1', '2']));
  });

  it('wraps a non-array scalar into a single-element list', () => {
    const { params } = render(buildInPredicate(fieldPath, 'solo'));
    expect(params).toContain('solo');
  });

  it('compiles an empty array to a match-nothing predicate', () => {
    const { sql: text } = render(buildInPredicate(fieldPath, []));
    expect(text.toLowerCase()).toContain('false');
  });

  it('treats null/undefined as empty (match nothing)', () => {
    expect(render(buildInPredicate(fieldPath, null)).sql.toLowerCase()).toContain('false');
    expect(render(buildInPredicate(fieldPath, undefined)).sql.toLowerCase()).toContain('false');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- in-filter.util.spec`
Expected: FAIL — cannot find module `./in-filter.util`.

- [ ] **Step 3: Implement the helper**

Create `src/pipelines/handlers/in-filter.util.ts`:

```ts
import { sql, SQL } from 'drizzle-orm';

/**
 * Build a parameterized `<fieldPath> IN (...)` predicate for the `in` filter
 * operator. The value is expression-resolved upstream and treated as an array
 * (a scalar is wrapped into a single-element list; null/undefined → empty).
 * JSONB fields are text (`data->>'field'`), so elements are bound as strings.
 * An empty array compiles to a match-nothing predicate (never invalid `IN ()`).
 */
export function buildInPredicate(fieldPath: SQL, value: unknown): SQL {
  const arr = value == null ? [] : Array.isArray(value) ? value : [value];
  if (arr.length === 0) {
    return sql`false`;
  }
  const elements = sql.join(
    arr.map((el) => sql`${String(el)}`),
    sql`, `,
  );
  return sql`${fieldPath} IN (${elements})`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm test -- in-filter.util.spec`
Expected: PASS (5 tests).

- [ ] **Step 5: Add `in` to the `data_query` op union**

In `src/pipelines/execution/step-handler.interface.ts`, change `DataQueryHandlerConfig.filters` (line ~85–88):

```ts
  filters?: Record<
    string,
    { op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'like' | 'in'; value: string }
  >;
```

- [ ] **Step 6: Write the failing `data_query` handler test**

Create `src/pipelines/handlers/data-query.handler.spec.ts` using the house mock (mirrors `data-delete.handler.spec.ts`). Include the `orderBy`/`limit`/`offset` chain methods:

```ts
jest.mock('../../db/client', () => {
  const queued: unknown[] = [];
  const methods = ['select', 'from', 'where', 'orderBy', 'limit', 'offset'];
  const chainable: Record<string, unknown> = {};
  for (const method of methods) chainable[method] = jest.fn(() => chainable);
  chainable.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(queued.length > 0 ? queued.shift() : []).then(resolve, reject);
  chainable.__queue = (result: unknown) => queued.push(result);
  chainable.__reset = () => {
    queued.length = 0;
    for (const method of methods) (chainable[method] as jest.Mock).mockClear();
  };
  return { db: chainable };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client';
import { DataQueryHandler } from './data-query.handler';
import { ExpressionEvaluator } from '../execution/expression-evaluator';
import { PipelineSchemasService } from '../pipeline-schemas.service';
import { PipelineContext } from '../execution/pipeline-context.interface';
import { PipelineStep } from '../types';

const mockDb = db as unknown as Record<string, jest.Mock> & {
  __queue: (r: unknown) => void;
  __reset: () => void;
};
const SCHEMA = { id: 'schema-1', projectId: 'proj-1', name: 'reader_items' };

function buildHandler() {
  const registry = { register: jest.fn() };
  const expressionEvaluator = {
    evaluateExpression: jest.fn((expr: unknown, context: PipelineContext) => {
      if (typeof expr !== 'string') return expr;
      if (expr.startsWith('steps.')) {
        const parts = expr.split('.').slice(1);
        let value: unknown = context.stepOutputs;
        for (const part of parts) {
          if (value == null || typeof value !== 'object') return undefined;
          value = (value as Record<string, unknown>)[part];
        }
        return value;
      }
      return expr;
    }),
  } as unknown as ExpressionEvaluator;
  const schemasService = { getById: jest.fn(async () => SCHEMA) } as unknown as PipelineSchemasService;
  return { handler: new DataQueryHandler(registry as any, expressionEvaluator, schemasService) };
}

const step = (config: unknown): PipelineStep =>
  ({ name: 'page', handlerType: 'data_query', config }) as unknown as PipelineStep;
const context = (stepOutputs: Record<string, unknown> = {}): PipelineContext =>
  ({ projectId: 'proj-1', stepOutputs, user: { id: 'user-1' } }) as unknown as PipelineContext;

function selectWhereQuery(): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(mockDb.where.mock.calls[0][0]);
}

describe('DataQueryHandler in operator', () => {
  beforeEach(() => mockDb.__reset());

  it('validateConfig accepts the in operator', () => {
    const { handler } = buildHandler();
    expect(() =>
      handler.validateConfig({
        schemaId: 'schema-1',
        filters: { feedId: { op: 'in', value: 'steps.prep.urls' } },
      } as any),
    ).not.toThrow();
  });

  it('filters feedId IN (folder urls) resolved from a prior step', async () => {
    const { handler } = buildHandler();
    mockDb.__queue([]); // page rows
    await handler.execute(
      context({ prep: { urls: ['https://a.com/feed', 'https://b.com/feed'] } }),
      step({
        schemaId: 'schema-1',
        filters: { feedId: { op: 'in', value: 'steps.prep.urls' } },
      }),
    );
    const { sql, params } = selectWhereQuery();
    expect(sql.toLowerCase()).toContain('in (');
    expect(params).toEqual(
      expect.arrayContaining(['https://a.com/feed', 'https://b.com/feed']),
    );
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm test -- data-query.handler.spec`
Expected: FAIL — `validateConfig` throws `Invalid operator 'in'` (and/or the IN SQL is absent).

- [ ] **Step 8: Wire `in` into the `data_query` handler**

In `src/pipelines/handlers/data-query.handler.ts`:

1. Add the import at the top (after existing imports):
```ts
import { buildInPredicate } from './in-filter.util';
```
2. Extend the whitelist (line ~60):
```ts
      const validOps = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'like', 'in'];
```
3. Add a case at the end of the `switch (filter.op)` block (after the `like` case, ~line 152):
```ts
          case 'in':
            filterConditions.push(buildInPredicate(fieldPath, value));
            break;
```

- [ ] **Step 9: Run it to verify it passes**

Run: `pnpm test -- data-query.handler.spec`
Expected: PASS (2 tests).

- [ ] **Step 10: Commit**

```bash
cd repos/ce/apps/backend
git add src/pipelines/handlers/in-filter.util.ts src/pipelines/handlers/in-filter.util.spec.ts src/pipelines/handlers/data-query.handler.ts src/pipelines/handlers/data-query.handler.spec.ts src/pipelines/execution/step-handler.interface.ts
git commit -m "feat(pipelines): add in operator to data_query"
```

---

### Task 2: `db_aggregate` `in` support

**Files:**
- Modify: `repos/ce/apps/backend/src/pipelines/handlers/db-aggregate.handler.ts` (whitelist ~55; switch ~105–127)
- Modify: `repos/ce/apps/backend/src/pipelines/execution/step-handler.interface.ts` (`DbAggregateHandlerConfig.filters` op union)
- Modify (test): `repos/ce/apps/backend/src/pipelines/handlers/db-aggregate.handler.spec.ts` — create if absent

**Interfaces:**
- Consumes: `buildInPredicate` from Task 1.
- Produces: `db_aggregate` count/group filters accept `op: 'in'` (used by `/api/counts` and folder count).

- [ ] **Step 1: Add `in` to the `db_aggregate` op union**

In `step-handler.interface.ts`, find `DbAggregateHandlerConfig.filters` and add `'in'` to its op union (same shape as `DataQueryHandlerConfig.filters`):

```ts
  filters?: Record<
    string,
    { op: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'like' | 'in'; value: string }
  >;
```

- [ ] **Step 2: Write the failing test**

Create `src/pipelines/handlers/db-aggregate.handler.spec.ts` using the house mock. Include chain methods `select`, `from`, `where`, `groupBy`:

```ts
jest.mock('../../db/client', () => {
  const queued: unknown[] = [];
  const methods = ['select', 'from', 'where', 'groupBy'];
  const chainable: Record<string, unknown> = {};
  for (const method of methods) chainable[method] = jest.fn(() => chainable);
  chainable.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(queued.length > 0 ? queued.shift() : []).then(resolve, reject);
  chainable.__queue = (result: unknown) => queued.push(result);
  chainable.__reset = () => {
    queued.length = 0;
    for (const method of methods) (chainable[method] as jest.Mock).mockClear();
  };
  return { db: chainable };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client';
import { DbAggregateHandler } from './db-aggregate.handler';
import { ExpressionEvaluator } from '../execution/expression-evaluator';
import { PipelineSchemasService } from '../pipeline-schemas.service';
import { PipelineContext } from '../execution/pipeline-context.interface';
import { PipelineStep } from '../types';

const mockDb = db as unknown as Record<string, jest.Mock> & {
  __queue: (r: unknown) => void;
  __reset: () => void;
};
const SCHEMA = { id: 'schema-1', projectId: 'proj-1', name: 'reader_items' };

function buildHandler() {
  const registry = { register: jest.fn() };
  const expressionEvaluator = {
    evaluateExpression: jest.fn((expr: unknown, context: PipelineContext) => {
      if (typeof expr !== 'string') return expr;
      if (expr.startsWith('steps.')) {
        const parts = expr.split('.').slice(1);
        let value: unknown = context.stepOutputs;
        for (const part of parts) {
          if (value == null || typeof value !== 'object') return undefined;
          value = (value as Record<string, unknown>)[part];
        }
        return value;
      }
      return expr;
    }),
  } as unknown as ExpressionEvaluator;
  const schemasService = { getById: jest.fn(async () => SCHEMA) } as unknown as PipelineSchemasService;
  return { handler: new DbAggregateHandler(registry as any, expressionEvaluator, schemasService) };
}

const step = (config: unknown): PipelineStep =>
  ({ name: 'count', handlerType: 'db_aggregate', config }) as unknown as PipelineStep;
const context = (stepOutputs: Record<string, unknown> = {}): PipelineContext =>
  ({ projectId: 'proj-1', stepOutputs, user: { id: 'user-1' } }) as unknown as PipelineContext;

describe('DbAggregateHandler in operator', () => {
  beforeEach(() => mockDb.__reset());

  it('validateConfig accepts the in operator', () => {
    const { handler } = buildHandler();
    expect(() =>
      handler.validateConfig({
        schemaId: 'schema-1',
        operation: 'count',
        filters: { feedId: { op: 'in', value: 'steps.prep.urls' } },
      } as any),
    ).not.toThrow();
  });

  it('counts with feedId IN (urls)', async () => {
    const { handler } = buildHandler();
    mockDb.__queue([{ result: '7' }]); // count(*) row
    const result = await handler.execute(
      context({ prep: { urls: ['https://a.com/feed', 'https://b.com/feed'] } }),
      step({
        schemaId: 'schema-1',
        operation: 'count',
        filters: { feedId: { op: 'in', value: 'steps.prep.urls' } },
      }),
    );
    expect(result.output).toEqual(expect.objectContaining({ operation: 'count', result: 7 }));
    const { sql, params } = new PgDialect().sqlToQuery(mockDb.where.mock.calls[0][0]);
    expect(sql.toLowerCase()).toContain('in (');
    expect(params).toEqual(
      expect.arrayContaining(['https://a.com/feed', 'https://b.com/feed']),
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test -- db-aggregate.handler.spec`
Expected: FAIL — `Invalid operator 'in'`.

- [ ] **Step 4: Wire `in` into the `db_aggregate` handler**

In `src/pipelines/handlers/db-aggregate.handler.ts`:

1. Add import:
```ts
import { buildInPredicate } from './in-filter.util';
```
2. Extend the whitelist (line ~55):
```ts
      const validFilterOps = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'like', 'in'];
```
3. Add a case after the `like` case in the filter switch (~line 126):
```ts
          case 'in':
            filterConditions.push(buildInPredicate(fieldPath, value));
            break;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm test -- db-aggregate.handler.spec`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd repos/ce/apps/backend
git add src/pipelines/handlers/db-aggregate.handler.ts src/pipelines/handlers/db-aggregate.handler.spec.ts src/pipelines/execution/step-handler.interface.ts
git commit -m "feat(pipelines): add in operator to db_aggregate"
```

---

### Task 3: `data_update` `in` support (folder mark-all-read)

**Files:**
- Modify: `repos/ce/apps/backend/src/pipelines/handlers/data-update.handler.ts` (whitelist ~51 — currently `['eq', 'ne']`; switch ~111–118)
- Modify: `repos/ce/apps/backend/src/pipelines/execution/step-handler.interface.ts` (`DataUpdateHandlerConfig.filters` op union ~135 — currently `'eq' | 'ne'`)
- Modify (test): `repos/ce/apps/backend/src/pipelines/handlers/data-update.handler.spec.ts` — create if absent

**Interfaces:**
- Consumes: `buildInPredicate` from Task 1.
- Produces: `data_update` filters accept `op: 'in'`; a filtered update over `feedId IN (urls) AND read = "false"` setting `read = "true"` updates all matching rows (folder mark-all-read).

- [ ] **Step 1: Add `in` to the `data_update` op union**

In `step-handler.interface.ts`, change `DataUpdateHandlerConfig.filters` (line ~135):

```ts
  filters?: Record<string, { op: 'eq' | 'ne' | 'in'; value: string }>;
```

- [ ] **Step 2: Write the failing test**

Create `src/pipelines/handlers/data-update.handler.spec.ts` using the house mock. Chain methods for update: `select`, `from`, `where`, `update`, `set`, `returning`, `limit`:

```ts
jest.mock('../../db/client', () => {
  const queued: unknown[] = [];
  const methods = ['select', 'from', 'where', 'update', 'set', 'returning', 'limit'];
  const chainable: Record<string, unknown> = {};
  for (const method of methods) chainable[method] = jest.fn(() => chainable);
  chainable.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(queued.length > 0 ? queued.shift() : []).then(resolve, reject);
  chainable.__queue = (result: unknown) => queued.push(result);
  chainable.__reset = () => {
    queued.length = 0;
    for (const method of methods) (chainable[method] as jest.Mock).mockClear();
  };
  return { db: chainable };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../../db/client';
import { DataUpdateHandler } from './data-update.handler';
import { ExpressionEvaluator } from '../execution/expression-evaluator';
import { PipelineSchemasService } from '../pipeline-schemas.service';
import { PipelineContext } from '../execution/pipeline-context.interface';
import { PipelineStep } from '../types';

const mockDb = db as unknown as Record<string, jest.Mock> & {
  __queue: (r: unknown) => void;
  __reset: () => void;
};
const SCHEMA = { id: 'schema-1', projectId: 'proj-1', name: 'reader_items' };

function buildHandler() {
  const registry = { register: jest.fn() };
  const expressionEvaluator = {
    evaluateExpression: jest.fn((expr: unknown, context: PipelineContext) => {
      if (typeof expr !== 'string') return expr;
      if (expr.startsWith('steps.')) {
        const parts = expr.split('.').slice(1);
        let value: unknown = context.stepOutputs;
        for (const part of parts) {
          if (value == null || typeof value !== 'object') return undefined;
          value = (value as Record<string, unknown>)[part];
        }
        return value;
      }
      return expr;
    }),
  } as unknown as ExpressionEvaluator;
  const schemasService = { getById: jest.fn(async () => SCHEMA) } as unknown as PipelineSchemasService;
  return { handler: new DataUpdateHandler(registry as any, expressionEvaluator, schemasService) };
}

const step = (config: unknown): PipelineStep =>
  ({ name: 'readAll', handlerType: 'data_update', config }) as unknown as PipelineStep;
const context = (stepOutputs: Record<string, unknown> = {}): PipelineContext =>
  ({ projectId: 'proj-1', stepOutputs, user: { id: 'user-1' } }) as unknown as PipelineContext;

describe('DataUpdateHandler in operator', () => {
  beforeEach(() => mockDb.__reset());

  it('validateConfig accepts the in operator', () => {
    const { handler } = buildHandler();
    expect(() =>
      handler.validateConfig({
        schemaId: 'schema-1',
        filters: { feedId: { op: 'in', value: 'steps.prep.urls' } },
        fields: { read: 'true' },
      } as any),
    ).not.toThrow();
  });

  it('marks all matching folder items read via feedId IN (urls)', async () => {
    const { handler } = buildHandler();
    mockDb.__queue([{ id: 'i1', data: { read: false } }, { id: 'i2', data: { read: false } }]); // select matches
    mockDb.__queue([{ id: 'i1', data: { read: true } }]); // update i1 .returning()
    mockDb.__queue([{ id: 'i2', data: { read: true } }]); // update i2 .returning()

    const result = await handler.execute(
      context({ prep: { urls: ['https://a.com/feed', 'https://b.com/feed'] } }),
      step({
        schemaId: 'schema-1',
        filters: {
          feedId: { op: 'in', value: 'steps.prep.urls' },
          read: { op: 'eq', value: 'false' },
        },
        fields: { read: 'true' },
      }),
    );

    expect((result.output as { count: number }).count).toBe(2);
    const { sql, params } = new PgDialect().sqlToQuery(mockDb.where.mock.calls[0][0]);
    expect(sql.toLowerCase()).toContain('in (');
    expect(params).toEqual(
      expect.arrayContaining(['https://a.com/feed', 'https://b.com/feed', 'false']),
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test -- data-update.handler.spec`
Expected: FAIL — `Invalid operator 'in'` (update whitelist is `['eq', 'ne']`).

- [ ] **Step 4: Wire `in` into the `data_update` handler**

In `src/pipelines/handlers/data-update.handler.ts`:

1. Add import:
```ts
import { buildInPredicate } from './in-filter.util';
```
2. Extend the whitelist (line ~51):
```ts
      const validOps = ['eq', 'ne', 'in'];
```
3. Add a case to the filter switch (after the `ne` case, ~line 118):
```ts
          case 'in':
            filterConditions.push(buildInPredicate(fieldPath, value));
            break;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm test -- data-update.handler.spec`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd repos/ce/apps/backend
git add src/pipelines/handlers/data-update.handler.ts src/pipelines/handlers/data-update.handler.spec.ts src/pipelines/execution/step-handler.interface.ts
git commit -m "feat(pipelines): add in operator to data_update"
```

---

### Task 4: Full suite + typecheck gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full pipelines test suite**

Run: `pnpm test -- pipelines`
Expected: PASS — all existing handler tests (incl. `data-delete.handler.spec.ts`) plus the three new specs are green. No existing operator behavior changed.

- [ ] **Step 2: Typecheck / build**

Run: `pnpm build`
Expected: no TypeScript errors (the three `op` unions now include `'in'`; `in-filter.util.ts` compiles).

- [ ] **Step 3: Final commit if any lint/format fixups were needed**

```bash
cd repos/ce/apps/backend
git add -A
git commit -m "chore(pipelines): lint/format for in operator" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage** — the spec's sole CE change is "add an `in` operator to `data_query`, `db_aggregate`, and `data_update`, empty array → match-nothing, bypass scalar coercion." Task 1 covers `data_query` + the shared helper (array coercion, empty-array `false`, text binding); Task 2 covers `db_aggregate`; Task 3 covers `data_update`; Task 4 gates the whole suite. Update-by-filter and `groupBy` are pre-existing (no task needed — confirmed in spec). Covered.

**Placeholder scan** — every step has concrete code, an exact command, and an expected result. No TBD/TODO.

**Type consistency** — the helper is `buildInPredicate(fieldPath: SQL, value: unknown): SQL` in all three tasks; the op unions all become `… | 'in'`; whitelists become the literal arrays shown. Consistent.

## Downstream (not in this plan)

This is Plan 1 of 3. Plan 2 (reader proxy-rule set: rewrite `/api/items`, add `/api/counts` + `/api/items/read-all`, `sortTs` ingest) and Plan 3 (reader client: paged fetch, pager, counts badges, mark-all-read) depend on this CE change being merged **and deployed** to the instance backing `reader.j5s.dev`, since the live pipelines call the deployed handlers.
