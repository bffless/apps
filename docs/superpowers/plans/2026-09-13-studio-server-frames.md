# Studio server frames (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every frame grab and contact sheet in the Studio app runs on CE's ffmpeg `frames` operation, so no step downloads a whole recording into the browser.

**Architecture:** Two new async job rules in the `studio` rule set (`POST /api/video/contact-sheet`, `POST /api/video/frames`). Each follows the existing `video/slice` shape: prep → job row → respond `{jobId}`, with the ffmpeg work in postSteps. The client polls them through the existing `runVideoJob` / `/api/studio/job` loop. A pure module (`src/lib/serverFrames.ts`) coerces results and maps them onto the existing `ContactSheet` type, so no consumer of sheets changes. The browser capture code is deleted at the end.

**Tech Stack:** BFFless proxy rules (YAML + ES5 `function_handler` files), `bffless` CLI (`rules test` / `rules validate`), React 19 + Redux Toolkit / RTK Query, MSW, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-13-studio-server-video-design.md` (PR 1 section). PR 2, which deletes ffmpeg.wasm, gets its own plan after this lands.

## Global Constraints

- Requires CE with the ffmpeg `frames` operation (ce#706, CE >= 0.4.35). No CE changes.
- The new rules use `order: 60` (contact-sheet) and `order: 61` (frames). Existing video rules use 56–59.
- `function_handler` files cannot import: write ES5 (`var`, no arrow functions), matching `rules/api/video/slice/post/prep.fn.js`.
- Mock parity: every new `/api/*` gets an MSW handler in `apps/studio/src/mocks/handlers.ts` returning the same shape, coerced by the same `toX()` function.
- No base64 in Redux or localStorage. Sheets and frames persist as `/api/uploads/...` URLs only.
- `data-testid`s are a contract. Do not rename or remove any.
- The `ContactSheet` type in `src/lib/frames.ts` stays unchanged; server sheets set `dataUrl: ''`.
- Verify commands (from the worktree root):
  - `pnpm --filter studio test:run`, `pnpm --filter studio lint`, `pnpm --filter studio build`
  - `npx --yes bffless@^0.2.0 rules test apps/studio/.bffless/proxy-rules/studio`
  - `npx --yes bffless@^0.2.0 rules validate apps/studio/.bffless/proxy-rules/studio`
- Commits use conventional titles (`feat(studio): …`, `test(studio): …`) and end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W4q3g61DdaBZirUK8CHuw3
  ```
- Never push, open a PR, or merge from a task. The controller does that after review, with the person's approval.

**Paths below are relative to `apps/studio/` unless they start with `docs/`.**

---

### Task 1: `POST /api/video/contact-sheet` rule

**Files:**
- Create: `.bffless/proxy-rules/studio/rules/api/video/contact-sheet/post/rule.yaml`
- Create: `.bffless/proxy-rules/studio/rules/api/video/contact-sheet/post/prep.fn.js`
- Create: `.bffless/proxy-rules/studio/rules/api/video/contact-sheet/post/prep.fn.test.yaml`
- Create: `.bffless/proxy-rules/studio/rules/api/video/contact-sheet/post/check.fn.js`
- Create: `.bffless/proxy-rules/studio/rules/api/video/contact-sheet/post/check.fn.test.yaml`

**Interfaces:**
- Produces:
  - request body `{ sourceUrl: string, projectId: string, times: number[], labels: string[], executor?: 'local'|'remote' }`;
  - response `{ jobId, status: 'pending' }`, or a 400 `{ error, code: 'BAD_REQUEST' }`;
  - a job row with `kind: 'video-contact-sheet'`, whose `result` is `{ sheets: [{ url, times, cols, rows, index, total, bytes }], drawn, executor?, timings?, bytesIn?, bytesOut? }`.

- [ ] **Step 1: Write the failing prep test**

`prep.fn.test.yaml`:

```yaml
handler: ./prep.fn.js
cases:
  - name: a valid request passes through, executor blank by default
    data:
      request:
        body:
          sourceUrl: /api/uploads/projects/p1/source/2026-09-13/a.mov
          projectId: p1
          times: [1.5, 31.5]
          labels: ["0:01", "0:31"]
    expect:
      result:
        ok: true
        notOk: false
        error: ""
        failJson: ""
        input: /api/uploads/projects/p1/source/2026-09-13/a.mov
        projectId: p1
        times: [1.5, 31.5]
        labels: ["0:01", "0:31"]
        executor: ""
  - name: an explicit remote executor is kept
    data:
      request:
        body:
          sourceUrl: /api/uploads/projects/p1/source/a.mp4
          projectId: p1
          times: [0]
          labels: ["0:00"]
          executor: remote
    expect:
      result:
        ok: true
        notOk: false
        error: ""
        failJson: ""
        input: /api/uploads/projects/p1/source/a.mp4
        projectId: p1
        times: [0]
        labels: ["0:00"]
        executor: remote
  - name: a source outside /api/uploads/ is refused
    data:
      request:
        body: { sourceUrl: "https://evil.example/a.mp4", projectId: p1, times: [1], labels: ["0:01"] }
    expect:
      result:
        ok: false
        notOk: true
        error: sourceUrl must be an /api/uploads/ path
        failJson: '{"error":"sourceUrl must be an /api/uploads/ path","code":"BAD_REQUEST"}'
        input: ""
        projectId: ""
        times: []
        labels: []
        executor: ""
  - name: a projectId with a slash is refused
    data:
      request:
        body: { sourceUrl: /api/uploads/projects/p1/source/a.mp4, projectId: "p1/../p2", times: [1], labels: ["0:01"] }
    expect:
      result:
        ok: false
        notOk: true
        error: projectId is required and must be a single path segment
        failJson: '{"error":"projectId is required and must be a single path segment","code":"BAD_REQUEST"}'
        input: ""
        projectId: ""
        times: []
        labels: []
        executor: ""
  - name: empty times are refused
    data:
      request:
        body: { sourceUrl: /api/uploads/projects/p1/source/a.mp4, projectId: p1, times: [], labels: [] }
    expect:
      result:
        ok: false
        notOk: true
        error: times must be 1-200 non-negative seconds
        failJson: '{"error":"times must be 1-200 non-negative seconds","code":"BAD_REQUEST"}'
        input: ""
        projectId: ""
        times: []
        labels: []
        executor: ""
  - name: labels must match times one for one
    data:
      request:
        body: { sourceUrl: /api/uploads/projects/p1/source/a.mp4, projectId: p1, times: [1, 2], labels: ["0:01"] }
    expect:
      result:
        ok: false
        notOk: true
        error: labels must be one string per time
        failJson: '{"error":"labels must be one string per time","code":"BAD_REQUEST"}'
        input: ""
        projectId: ""
        times: []
        labels: []
        executor: ""
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx --yes bffless@^0.2.0 rules test apps/studio/.bffless/proxy-rules/studio`
Expected: the new cases FAIL, because `./prep.fn.js` does not exist yet. The existing 15 cases still pass.

- [ ] **Step 3: Write `prep.fn.js`**

```js
function handler({ request }) {
  var body = (request && request.body) || {}
  var sourceUrl = String(body.sourceUrl || '')
  var pid = String(body.projectId || '')

  function no(msg) {
    return {
      ok: false, notOk: true, error: msg,
      failJson: JSON.stringify({ error: msg, code: 'BAD_REQUEST' }),
      input: '', projectId: '', times: [], labels: [], executor: '',
    }
  }

  if (sourceUrl.indexOf('/api/uploads/') !== 0 || sourceUrl.indexOf('..') !== -1) {
    return no('sourceUrl must be an /api/uploads/ path')
  }
  if (pid === '' || pid.indexOf('..') !== -1 || pid.indexOf('/') !== -1) {
    return no('projectId is required and must be a single path segment')
  }

  // CE's MAX_STILLS_PER_JOB is 200 (ffmpeg.handler.ts), measured on times.length.
  var rawTimes = body.times
  if (!rawTimes || typeof rawTimes.length !== 'number' || rawTimes.length === 0 || rawTimes.length > 200) {
    return no('times must be 1-200 non-negative seconds')
  }
  var times = []
  for (var i = 0; i < rawTimes.length; i++) {
    var t = rawTimes[i]
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return no('times must be 1-200 non-negative seconds')
    times.push(t)
  }

  var rawLabels = body.labels
  if (!rawLabels || typeof rawLabels.length !== 'number' || rawLabels.length !== times.length) {
    return no('labels must be one string per time')
  }
  var labels = []
  for (var j = 0; j < rawLabels.length; j++) {
    if (typeof rawLabels[j] !== 'string') return no('labels must be one string per time')
    labels.push(rawLabels[j])
  }

  return {
    ok: true, notOk: false, error: '', failJson: '',
    input: sourceUrl, projectId: pid, times: times, labels: labels,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
```

- [ ] **Step 4: Write the failing check test**

`check.fn.test.yaml`:

```yaml
handler: ./check.fn.js
cases:
  - name: sheets map to serve urls with their grid and byte size
    data:
      steps:
        sheets:
          sheets:
            - { storage_path: o/r/uploads/projects/p1/thumbnails/server/u1/sheet-01.jpg, content_type: image/jpeg, size: 1200, times: [1, 2, 3, 4], index: 0, total: 2, cols: 3, rows: 2 }
            - { storage_path: o/r/uploads/projects/p1/thumbnails/server/u1/sheet-02.jpg, content_type: image/jpeg, size: 800, times: [5], index: 1, total: 2, cols: 1, rows: 1 }
          count: 5
          drawn: true
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: true
        notOk: false
        error: ""
        data:
          sheets:
            - { url: /api/uploads/projects/p1/thumbnails/server/u1/sheet-01.jpg, times: [1, 2, 3, 4], cols: 3, rows: 2, index: 0, total: 2, bytes: 1200 }
            - { url: /api/uploads/projects/p1/thumbnails/server/u1/sheet-02.jpg, times: [5], cols: 1, rows: 1, index: 1, total: 2, bytes: 800 }
          drawn: true
  - name: executor and timings ride along when CE reports them
    data:
      steps:
        sheets:
          sheets:
            - { storage_path: o/r/uploads/projects/p1/thumbnails/server/u1/sheet-01.jpg, content_type: image/jpeg, size: 10, times: [1], index: 0, total: 1, cols: 1, rows: 1 }
          count: 1
          drawn: false
          executor: remote
          timings: { totalMs: 900 }
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: true
        notOk: false
        error: ""
        data:
          sheets:
            - { url: /api/uploads/projects/p1/thumbnails/server/u1/sheet-01.jpg, times: [1], cols: 1, rows: 1, index: 0, total: 1, bytes: 10 }
          drawn: false
          executor: remote
          timings: { totalMs: 900 }
  - name: no step output is a failure
    data:
      steps: {}
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: false
        notOk: true
        error: Server contact-sheet capture failed
        data: null
  - name: an empty sheet list is a failure
    data:
      steps:
        sheets: { sheets: [], count: 0, drawn: true }
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: false
        notOk: true
        error: Server contact-sheet capture failed
        data: null
```

- [ ] **Step 5: Write `check.fn.js`**

```js
function handler({ steps, deployment, stepErrors }) {
  var out = (steps && steps.sheets) || null
  var list = out && out.sheets
  if (!list || typeof list.length !== 'number' || list.length === 0) {
    // Forward-compatible with CE's `stepErrors.<step>` root (ce#662), as in slice/post/check.fn.js.
    var err = stepErrors && stepErrors.sheets
    var detail = err && (err.code || err.message) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server contact-sheet capture failed' + detail, data: null }
  }
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  function toUrl(p) {
    var key = p.indexOf(prefix) === 0 ? p.slice(prefix.length) : p
    return '/api/uploads/' + key
  }
  var sheets = []
  for (var i = 0; i < list.length; i++) {
    var s = list[i] || {}
    if (typeof s.storage_path !== 'string' || !s.storage_path) continue
    sheets.push({
      url: toUrl(s.storage_path),
      times: s.times || [],
      cols: typeof s.cols === 'number' ? s.cols : 0,
      rows: typeof s.rows === 'number' ? s.rows : 0,
      index: typeof s.index === 'number' ? s.index : i,
      total: typeof s.total === 'number' ? s.total : list.length,
      bytes: typeof s.size === 'number' ? s.size : 0,
    })
  }
  var data = { sheets: sheets, drawn: out.drawn === true }
  var stats = ['executor', 'timings', 'bytesIn', 'bytesOut']
  for (var k = 0; k < stats.length; k++) {
    if (out[stats[k]] !== undefined && out[stats[k]] !== null) data[stats[k]] = out[stats[k]]
  }
  return { ok: true, notOk: false, error: '', data: data }
}
```

- [ ] **Step 6: Write `rule.yaml`**

```yaml
targetUrl: ""
order: 60
timeout: 120000
pipeline:
  name: Server contact sheets (ffmpeg frames + tile, async)
  description: "POST { sourceUrl, projectId, times, labels, executor? } -> ENQUEUE a job (kind 'video-contact-sheet'); CE's ffmpeg `frames` op (ce#706, CE >= 0.4.35) grabs one still per `times` entry, burns the parallel `labels` into the bottom-left, and tiles 12 per sheet, 3 wide. Result { sheets: [{ url, times, cols, rows, index, total, bytes }], drawn } polled via /api/studio/job. Replaces the browser capture in src/lib/frames.ts."
  steps:
    - id: prep
      name: prep
      handler: function_handler
      code: ./prep.fn.js
    - id: refuse
      name: refuse
      handler: response_handler
      config:
        condition: steps.prep.notOk
        body: "{{{steps.prep.failJson}}}"
        status: 400
        contentType: application/json
    - id: createJob
      name: createJob
      handler: data_create
      config:
        condition: steps.prep.ok
        fields:
          kind: "'video-contact-sheet'"
          status: "'pending'"
          request: request.body
        schemaId: $schema:studio_jobs
    - id: respond
      name: respond
      handler: response_handler
      config:
        condition: steps.prep.ok
        body: |-
          {
            "jobId": "{{steps.createJob.id}}",
            "status": "pending"
          }
        status: 200
        contentType: application/json
  postSteps:
    - id: setRunning
      name: setRunning
      handler: data_update
      config:
        condition: steps.prep.ok
        fields:
          status: "'running'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
    - id: sheets
      name: sheets
      handler: ffmpeg_handler
      config:
        condition: steps.prep.ok
        operation: frames
        # Template-evaluated like slice's: empty string => CE's default executor.
        executor: "{{steps.prep.executor}}"
        # input/outputPrefix are template-resolved - always wrap in {{}}; times and
        # draw.text are expression-evaluated and take bare paths.
        input: "{{steps.prep.input}}"
        outputPrefix: "projects/{{steps.prep.projectId}}/thumbnails/server/{{uuid()}}"
        times: steps.prep.times
        # CONTACT_SHEET_CELL in src/lib/frames.ts - the cell height the browser sheets used.
        height: 720
        draw:
          text: steps.prep.labels
          position: bottom-left
          size: 0.1
        # tile.perSheet / tile.columns are literals (CE does not resolve them). They must
        # match SERVER_SHEET_CELLS / SERVER_SHEET_COLUMNS in src/lib/serverFrames.ts.
        tile:
          perSheet: 12
          columns: 3
    - id: check
      name: check
      handler: function_handler
      code: ./check.fn.js
      config:
        condition: steps.prep.ok
    - id: finishOk
      name: finishOk
      handler: data_update
      config:
        fields:
          result: steps.check.data
          status: "'done'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
        condition: steps.check.ok
    - id: finishErr
      name: finishErr
      handler: data_update
      config:
        fields:
          error: steps.check.error
          status: "'error'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
        condition: steps.check.notOk
  validators: []
description: "Server-side contact sheets for the director (prep) and the per-scene refiner, via CE's ffmpeg_handler `frames` op with draw + tile (CE >= 0.4.35). The browser never downloads the source. No secrets. No validators, matching the other studio video rules."
```

- [ ] **Step 7: Run the rule tests and validation**

Run: `npx --yes bffless@^0.2.0 rules test apps/studio/.bffless/proxy-rules/studio && npx --yes bffless@^0.2.0 rules validate apps/studio/.bffless/proxy-rules/studio`
Expected: all cases pass (15 existing + 10 new) and validation reports no errors. If the fixture schema rejects a `request` root, compare with `apps/workflow/.bffless/proxy-rules/workflow/rules/api/workflow/files/register/post/normalize.fn.test.yaml`, which uses the same `data.request.body` shape.

- [ ] **Step 8: Commit**

```bash
git add apps/studio/.bffless/proxy-rules/studio/rules/api/video/contact-sheet
git commit -m "feat(studio): server contact-sheet rule over CE's ffmpeg frames op"
```

---

### Task 2: `POST /api/video/frames` rule

**Files:**
- Create: `.bffless/proxy-rules/studio/rules/api/video/frames/post/rule.yaml`
- Create: `.bffless/proxy-rules/studio/rules/api/video/frames/post/prep.fn.js`
- Create: `.bffless/proxy-rules/studio/rules/api/video/frames/post/prep.fn.test.yaml`
- Create: `.bffless/proxy-rules/studio/rules/api/video/frames/post/check.fn.js`
- Create: `.bffless/proxy-rules/studio/rules/api/video/frames/post/check.fn.test.yaml`

**Interfaces:**
- Produces:
  - request body `{ sourceUrl: string, projectId: string, times: number[], height: number, executor?: 'local'|'remote' }`;
  - response `{ jobId, status }`;
  - a job row with `kind: 'video-frames'`, whose `result` is `{ frames: [{ time, url }], executor?, timings?, bytesIn?, bytesOut? }`, in request order.

- [ ] **Step 1: Write the failing prep test**

`prep.fn.test.yaml`:

```yaml
handler: ./prep.fn.js
cases:
  - name: a valid request passes through
    data:
      request:
        body: { sourceUrl: /api/uploads/projects/p1/source/a.mov, projectId: p1, times: [10, 12.5], height: 720 }
    expect:
      result:
        ok: true
        notOk: false
        error: ""
        failJson: ""
        input: /api/uploads/projects/p1/source/a.mov
        projectId: p1
        times: [10, 12.5]
        height: 720
        executor: ""
  - name: a height outside 64-4320 is refused
    data:
      request:
        body: { sourceUrl: /api/uploads/projects/p1/source/a.mov, projectId: p1, times: [10], height: 8000 }
    expect:
      result:
        ok: false
        notOk: true
        error: height must be an integer from 64 to 4320
        failJson: '{"error":"height must be an integer from 64 to 4320","code":"BAD_REQUEST"}'
        input: ""
        projectId: ""
        times: []
        height: 0
        executor: ""
  - name: a source outside /api/uploads/ is refused
    data:
      request:
        body: { sourceUrl: /etc/passwd, projectId: p1, times: [10], height: 720 }
    expect:
      result:
        ok: false
        notOk: true
        error: sourceUrl must be an /api/uploads/ path
        failJson: '{"error":"sourceUrl must be an /api/uploads/ path","code":"BAD_REQUEST"}'
        input: ""
        projectId: ""
        times: []
        height: 0
        executor: ""
  - name: a negative time is refused
    data:
      request:
        body: { sourceUrl: /api/uploads/projects/p1/source/a.mov, projectId: p1, times: [-1], height: 720 }
    expect:
      result:
        ok: false
        notOk: true
        error: times must be 1-200 non-negative seconds
        failJson: '{"error":"times must be 1-200 non-negative seconds","code":"BAD_REQUEST"}'
        input: ""
        projectId: ""
        times: []
        height: 0
        executor: ""
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx --yes bffless@^0.2.0 rules test apps/studio/.bffless/proxy-rules/studio`
Expected: the new frames cases FAIL because the handler file is missing.

- [ ] **Step 3: Write `prep.fn.js`**

```js
function handler({ request }) {
  var body = (request && request.body) || {}
  var sourceUrl = String(body.sourceUrl || '')
  var pid = String(body.projectId || '')

  function no(msg) {
    return {
      ok: false, notOk: true, error: msg,
      failJson: JSON.stringify({ error: msg, code: 'BAD_REQUEST' }),
      input: '', projectId: '', times: [], height: 0, executor: '',
    }
  }

  if (sourceUrl.indexOf('/api/uploads/') !== 0 || sourceUrl.indexOf('..') !== -1) {
    return no('sourceUrl must be an /api/uploads/ path')
  }
  if (pid === '' || pid.indexOf('..') !== -1 || pid.indexOf('/') !== -1) {
    return no('projectId is required and must be a single path segment')
  }
  var rawTimes = body.times
  if (!rawTimes || typeof rawTimes.length !== 'number' || rawTimes.length === 0 || rawTimes.length > 200) {
    return no('times must be 1-200 non-negative seconds')
  }
  var times = []
  for (var i = 0; i < rawTimes.length; i++) {
    var t = rawTimes[i]
    if (typeof t !== 'number' || !isFinite(t) || t < 0) return no('times must be 1-200 non-negative seconds')
    times.push(t)
  }
  var height = body.height
  if (typeof height !== 'number' || Math.floor(height) !== height || height < 64 || height > 4320) {
    return no('height must be an integer from 64 to 4320')
  }
  return {
    ok: true, notOk: false, error: '', failJson: '',
    input: sourceUrl, projectId: pid, times: times, height: height,
    executor: body.executor === 'local' || body.executor === 'remote' ? body.executor : '',
  }
}
```

- [ ] **Step 4: Write the failing check test**

`check.fn.test.yaml`:

```yaml
handler: ./check.fn.js
cases:
  - name: frames map to serve urls in request order
    data:
      steps:
        frames:
          frames:
            - { time: 10, storage_path: o/r/uploads/projects/p1/frames/server/u1/frame-01.jpg, content_type: image/jpeg, size: 50 }
            - { time: 12.5, storage_path: o/r/uploads/projects/p1/frames/server/u1/frame-02.jpg, content_type: image/jpeg, size: 60 }
          count: 2
          drawn: false
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: true
        notOk: false
        error: ""
        data:
          frames:
            - { time: 10, url: /api/uploads/projects/p1/frames/server/u1/frame-01.jpg }
            - { time: 12.5, url: /api/uploads/projects/p1/frames/server/u1/frame-02.jpg }
  - name: no step output is a failure
    data:
      steps: {}
      deployment: { owner: o, repo: r }
    expect:
      result:
        ok: false
        notOk: true
        error: Server frame capture failed
        data: null
```

- [ ] **Step 5: Write `check.fn.js`**

```js
function handler({ steps, deployment, stepErrors }) {
  var out = (steps && steps.frames) || null
  var list = out && out.frames
  if (!list || typeof list.length !== 'number' || list.length === 0) {
    var err = stepErrors && stepErrors.frames
    var detail = err && (err.code || err.message) ? ' (' + [err.code, err.message].filter(Boolean).join(': ') + ')' : ''
    return { ok: false, notOk: true, error: 'Server frame capture failed' + detail, data: null }
  }
  var prefix = deployment.owner + '/' + deployment.repo + '/uploads/'
  var frames = []
  for (var i = 0; i < list.length; i++) {
    var f = list[i] || {}
    if (typeof f.storage_path !== 'string' || !f.storage_path) continue
    var key = f.storage_path.indexOf(prefix) === 0 ? f.storage_path.slice(prefix.length) : f.storage_path
    frames.push({ time: f.time, url: '/api/uploads/' + key })
  }
  var data = { frames: frames }
  var stats = ['executor', 'timings', 'bytesIn', 'bytesOut']
  for (var k = 0; k < stats.length; k++) {
    if (out[stats[k]] !== undefined && out[stats[k]] !== null) data[stats[k]] = out[stats[k]]
  }
  return { ok: true, notOk: false, error: '', data: data }
}
```

- [ ] **Step 6: Write `rule.yaml`**

```yaml
targetUrl: ""
order: 61
timeout: 120000
pipeline:
  name: Server frame grabs (ffmpeg frames, async)
  description: "POST { sourceUrl, projectId, times, height, executor? } -> ENQUEUE a job (kind 'video-frames'); CE's ffmpeg `frames` op (CE >= 0.4.35) grabs one clean still per `times` entry at `height` px. Result { frames: [{ time, url }] } in request order, polled via /api/studio/job. Scene card thumbs, blog images and the blog re-frame strip."
  steps:
    - id: prep
      name: prep
      handler: function_handler
      code: ./prep.fn.js
    - id: refuse
      name: refuse
      handler: response_handler
      config:
        condition: steps.prep.notOk
        body: "{{{steps.prep.failJson}}}"
        status: 400
        contentType: application/json
    - id: createJob
      name: createJob
      handler: data_create
      config:
        condition: steps.prep.ok
        fields:
          kind: "'video-frames'"
          status: "'pending'"
          request: request.body
        schemaId: $schema:studio_jobs
    - id: respond
      name: respond
      handler: response_handler
      config:
        condition: steps.prep.ok
        body: |-
          {
            "jobId": "{{steps.createJob.id}}",
            "status": "pending"
          }
        status: 200
        contentType: application/json
  postSteps:
    - id: setRunning
      name: setRunning
      handler: data_update
      config:
        condition: steps.prep.ok
        fields:
          status: "'running'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
    - id: frames
      name: frames
      handler: ffmpeg_handler
      config:
        condition: steps.prep.ok
        operation: frames
        executor: "{{steps.prep.executor}}"
        input: "{{steps.prep.input}}"
        outputPrefix: "projects/{{steps.prep.projectId}}/frames/server/{{uuid()}}"
        times: steps.prep.times
        # CE's knob() accepts a numeric string, so a template works here.
        height: "{{steps.prep.height}}"
    - id: check
      name: check
      handler: function_handler
      code: ./check.fn.js
      config:
        condition: steps.prep.ok
    - id: finishOk
      name: finishOk
      handler: data_update
      config:
        fields:
          result: steps.check.data
          status: "'done'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
        condition: steps.check.ok
    - id: finishErr
      name: finishErr
      handler: data_update
      config:
        fields:
          error: steps.check.error
          status: "'error'"
        recordId: steps.createJob.id
        schemaId: $schema:studio_jobs
        condition: steps.check.notOk
  validators: []
description: "Server-side still frames via CE's ffmpeg_handler `frames` op (CE >= 0.4.35), no draw and no tile. One source per job. No secrets."
```

- [ ] **Step 7: Run the rule tests and validation**

Run: `npx --yes bffless@^0.2.0 rules test apps/studio/.bffless/proxy-rules/studio && npx --yes bffless@^0.2.0 rules validate apps/studio/.bffless/proxy-rules/studio`
Expected: everything passes, and validation reports no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/studio/.bffless/proxy-rules/studio/rules/api/video/frames
git commit -m "feat(studio): server frame-grab rule over CE's ffmpeg frames op"
```

---

### Task 3: Pure client helpers (`serverFrames.ts`, `imageSize.ts`, sheet budget)

**Files:**
- Create: `src/lib/serverFrames.ts`
- Create: `src/lib/serverFrames.test.ts`
- Create: `src/lib/imageSize.ts`
- Modify: `src/lib/globalSheet.ts` (add the optional `perSheet` budget)
- Modify: `src/lib/globalSheet.test.ts` if it exists; otherwise create it

**Interfaces:**
- Consumes: `clockLabel`, `sampleTimes`, `MAX_SHEETS` from `src/lib/contactSheet.ts`; the `ContactSheet` type from `src/lib/frames.ts`; `planContactSheet` and `totalDuration` / `globalToLocal` / `SourceLike` as used today in `globalSheet.ts`.
- Produces:
  - `SERVER_SHEET_CELLS = 12`, `SERVER_SHEET_COLUMNS = 3`, `SERVER_SHEET_GAP = 2`
  - `type ServerSheet = { url: string; times: number[]; cols: number; rows: number; bytes: number }`
  - `type ServerFrame = { time: number; url: string }`
  - `toServerSheets(raw: unknown): ServerSheet[]`, which throws when there are no sheets
  - `toServerFrames(raw: unknown): ServerFrame[]`, which throws when there are no frames
  - `sheetLabels(times: number[]): string[]`
  - `toContactSheets(sheets: ServerSheet[], sizes: { width: number; height: number }[], displayTimes: number[], interval: number): ContactSheet[]`
  - `restampSheets(sheets: ContactSheet[]): ContactSheet[]`, which sets `index` and `total` across the combined list
  - `imageSize(url: string): Promise<{ width: number; height: number }>`, which resolves `{0,0}` on error
  - `planGlobalSheetCaptures(sources: SourceLike[], perSheet?: number): GlobalCapture[]`

- [ ] **Step 1: Write the failing tests**

`src/lib/serverFrames.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  SERVER_SHEET_GAP,
  toServerSheets,
  toServerFrames,
  sheetLabels,
  toContactSheets,
  restampSheets,
} from './serverFrames'

const rawSheets = {
  sheets: [
    { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-01.jpg', times: [1, 2, 3, 4], cols: 3, rows: 2, index: 0, total: 2, bytes: 1200 },
    { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-02.jpg', times: [5], cols: 1, rows: 1, index: 1, total: 2, bytes: 300 },
  ],
  drawn: true,
}

describe('toServerSheets', () => {
  it('keeps url, times, grid and bytes', () => {
    expect(toServerSheets(rawSheets)).toEqual([
      { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-01.jpg', times: [1, 2, 3, 4], cols: 3, rows: 2, bytes: 1200 },
      { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-02.jpg', times: [5], cols: 1, rows: 1, bytes: 300 },
    ])
  })
  it('accepts the job row result as a JSON string', () => {
    expect(toServerSheets(JSON.stringify(rawSheets))).toHaveLength(2)
  })
  it('throws when the job came back without sheets', () => {
    expect(() => toServerSheets({ sheets: [] })).toThrow('The contact-sheet job finished without any sheets.')
    expect(() => toServerSheets(null)).toThrow('The contact-sheet job finished without any sheets.')
  })
})

describe('toServerFrames', () => {
  it('keeps time and url in order, dropping entries without a url', () => {
    expect(
      toServerFrames({ frames: [{ time: 10, url: '/api/uploads/a.jpg' }, { time: 11 }, { time: 12, url: '/api/uploads/b.jpg' }] }),
    ).toEqual([
      { time: 10, url: '/api/uploads/a.jpg' },
      { time: 12, url: '/api/uploads/b.jpg' },
    ])
  })
  it('throws when there are no frames', () => {
    expect(() => toServerFrames({ frames: [] })).toThrow('The frame job finished without any frames.')
  })
})

describe('sheetLabels', () => {
  it('uses the burned-in clock format', () => {
    expect(sheetLabels([5.9, 65, 3725])).toEqual(['0:05', '1:05', '1:02:05'])
  })
})

describe('toContactSheets', () => {
  it('derives cell geometry from the image size and stamps display times by position', () => {
    const got = toContactSheets(
      toServerSheets(rawSheets),
      [
        { width: 3 * 1280 + 4 * SERVER_SHEET_GAP, height: 2 * 720 + 3 * SERVER_SHEET_GAP },
        { width: 1280 + 2 * SERVER_SHEET_GAP, height: 720 + 2 * SERVER_SHEET_GAP },
      ],
      [101, 102, 103, 104, 105],
      1,
    )
    expect(got[0]).toEqual({
      dataUrl: '',
      url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-01.jpg',
      width: 3848,
      height: 1446,
      cols: 3,
      rows: 2,
      cellWidth: 1280,
      cellHeight: 720,
      gap: 2,
      count: 4,
      times: [101, 102, 103, 104],
      interval: 1,
      bytes: 1200,
      index: 0,
      total: 2,
    })
    expect(got[1].times).toEqual([105])
    expect(got[1].cellWidth).toBe(1280)
  })
  it('leaves geometry at 0 when the image size is unknown', () => {
    const [s] = toContactSheets(toServerSheets(rawSheets), [{ width: 0, height: 0 }], [1, 2, 3, 4, 5], 1)
    expect(s.cellWidth).toBe(0)
    expect(s.cellHeight).toBe(0)
  })
})

describe('restampSheets', () => {
  it('numbers sheets across the combined list', () => {
    const a = toContactSheets(toServerSheets(rawSheets), [], [1, 2, 3, 4, 5], 1)
    const b = toContactSheets(toServerSheets(rawSheets), [], [6, 7, 8, 9, 10], 1)
    expect(restampSheets([...a, ...b]).map((s) => [s.index, s.total])).toEqual([[0, 4], [1, 4], [2, 4], [3, 4]])
  })
})
```

`src/lib/globalSheet.test.ts` (append these cases if the file exists, keeping its imports):

```ts
import { describe, it, expect } from 'vitest'
import { planGlobalSheetCaptures } from './globalSheet'

describe('planGlobalSheetCaptures sheet budget', () => {
  it('keeps the full 120-frame budget for one long recording', () => {
    expect(planGlobalSheetCaptures([{ id: 'a', duration: 3600 }], 12)).toHaveLength(120)
  })
  it('reserves one sheet per extra recording so server tiling stays within 10 sheets', () => {
    const got = planGlobalSheetCaptures(
      [{ id: 'a', duration: 1800 }, { id: 'b', duration: 1800 }, { id: 'c', duration: 1800 }],
      12,
    )
    expect(got).toHaveLength(12 * 8)
    const perSource = ['a', 'b', 'c'].map((id) => got.filter((c) => c.sourceId === id).length)
    const sheets = perSource.reduce((n, count) => n + Math.ceil(count / 12), 0)
    expect(sheets).toBeLessThanOrEqual(10)
  })
  it('is unchanged when no budget is passed', () => {
    const sources = [{ id: 'a', duration: 1800 }, { id: 'b', duration: 1800 }]
    expect(planGlobalSheetCaptures(sources)).toHaveLength(120)
  })
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter studio exec vitest run src/lib/serverFrames.test.ts src/lib/globalSheet.test.ts`
Expected: FAIL. `./serverFrames` does not exist, and the budget case returns 120 instead of 96.

- [ ] **Step 3: Write `src/lib/serverFrames.ts`**

```ts
/**
 * Server contact sheets and frame grabs (CE's ffmpeg `frames` op behind
 * /api/video/contact-sheet and /api/video/frames). Pure: coerces job results
 * (shared by MSW and the real rules, per the mock-parity rule) and maps them
 * onto the existing `ContactSheet` shape, so the director, refiner and
 * filmstrip read server sheets exactly as they read the old browser ones.
 */
import { clockLabel } from './contactSheet'
import type { ContactSheet } from './frames'

/** Stills per sheet: the contact-sheet rule's `tile.perSheet` literal. */
export const SERVER_SHEET_CELLS = 12
/** Grid width: the rule's `tile.columns` literal. */
export const SERVER_SHEET_COLUMNS = 3
/** CE tiles with `padding=2:margin=2` (ce#706 `buildTileArgs`), the same gap `cellGeometry` assumes. */
export const SERVER_SHEET_GAP = 2

export type ServerSheet = { url: string; times: number[]; cols: number; rows: number; bytes: number }
export type ServerFrame = { time: number; url: string }

function parse(raw: unknown): Record<string, unknown> | null {
  const obj = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function toServerSheets(raw: unknown): ServerSheet[] {
  const list = parse(raw)?.sheets
  const out: ServerSheet[] = []
  for (const item of Array.isArray(list) ? list : []) {
    const r = (item ?? {}) as Record<string, unknown>
    if (typeof r.url !== 'string' || !r.url) continue
    const times = Array.isArray(r.times) ? r.times.filter(finite) : []
    const cols = finite(r.cols) && r.cols > 0 ? r.cols : Math.max(1, Math.min(times.length, SERVER_SHEET_COLUMNS))
    const rows = finite(r.rows) && r.rows > 0 ? r.rows : Math.max(1, Math.ceil(times.length / cols))
    out.push({ url: r.url, times, cols, rows, bytes: finite(r.bytes) ? r.bytes : 0 })
  }
  if (out.length === 0) throw new Error('The contact-sheet job finished without any sheets.')
  return out
}

export function toServerFrames(raw: unknown): ServerFrame[] {
  const list = parse(raw)?.frames
  const out: ServerFrame[] = []
  for (const item of Array.isArray(list) ? list : []) {
    const r = (item ?? {}) as Record<string, unknown>
    if (typeof r.url !== 'string' || !r.url || !finite(r.time)) continue
    out.push({ time: r.time, url: r.url })
  }
  if (out.length === 0) throw new Error('The frame job finished without any frames.')
  return out
}

/** The text CE burns onto each cell: the same clock the browser sheets drew. */
export function sheetLabels(times: number[]): string[] {
  return times.map(clockLabel)
}

/**
 * Map server sheets onto `ContactSheet`. `displayTimes` are the times the sheet
 * should REPORT, which can differ from the local times sent to CE (prep sheets
 * report global times). They are assigned by position: sheet i holds the next
 * `sheets[i].times.length` entries. `sizes[i]` is the sheet JPEG's natural size;
 * cell geometry is derived from it, or left at 0 when unknown.
 */
export function toContactSheets(
  sheets: ServerSheet[],
  sizes: { width: number; height: number }[],
  displayTimes: number[],
  interval: number,
): ContactSheet[] {
  const gap = SERVER_SHEET_GAP
  let offset = 0
  return sheets.map((s, i) => {
    const times = displayTimes.slice(offset, offset + s.times.length)
    offset += s.times.length
    const width = sizes[i]?.width ?? 0
    const height = sizes[i]?.height ?? 0
    return {
      dataUrl: '',
      url: s.url,
      width,
      height,
      cols: s.cols,
      rows: s.rows,
      cellWidth: width > 0 ? (width - (s.cols + 1) * gap) / s.cols : 0,
      cellHeight: height > 0 ? (height - (s.rows + 1) * gap) / s.rows : 0,
      gap,
      count: times.length,
      times,
      interval,
      bytes: s.bytes,
      index: i,
      total: sheets.length,
    }
  })
}

/** Number sheets gathered from several jobs as one set ("Sheet 2 of 7"). */
export function restampSheets(sheets: ContactSheet[]): ContactSheet[] {
  return sheets.map((s, i) => ({ ...s, index: i, total: sheets.length }))
}
```

- [ ] **Step 4: Write `src/lib/imageSize.ts`**

```ts
/** Natural pixel size of an image URL, or `{0,0}` if it fails to load. Never rejects. */
export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = url
  })
}
```

- [ ] **Step 5: Add the budget to `src/lib/globalSheet.ts`**

Replace the file with:

```ts
import { planContactSheet, sampleTimes, MAX_SHEETS } from './contactSheet'
import { globalToLocal, totalDuration, type SourceLike } from './sources'

export type GlobalCapture = { globalTime: number; sourceId: string; localTime: number }

/**
 * Finest spacing for the whole-talk director sheet — 1 s, like the per-scene
 * refiner (`SCENE_MIN_INTERVAL_SECONDS`), NOT the 5 s clip-wide floor. We want to
 * MAXIMIZE frames within the ≤10-image / 120-frame budget: a short multi-video
 * project (e.g. 66 s) sampled at 5 s used only ~2 of 10 sheets; at 1 s it fills
 * the budget (the cap still widens the interval automatically for long talks).
 */
const GLOBAL_MIN_INTERVAL_SECONDS = 1

/**
 * Plan the whole-talk director contact sheet across many sources (story 09c).
 * Spacing is computed on the COMBINED duration with a 1 s density floor (so it
 * fills the ≤10-image budget), then each global timestamp is routed to the
 * source + local time it should be captured from. The burned-in label uses the
 * GLOBAL time so the director reads one continuous timeline.
 *
 * `perSheet`: when sheets are tiled per recording on the server (12 stills each),
 * every boundary between recordings can cost one extra sheet, and the director
 * reads only the first `MAX_SHEETS`. Passing it caps the frame count at
 * `perSheet × (MAX_SHEETS − (recordings − 1))`, which keeps
 * Σ ceil(nᵢ / perSheet) ≤ MAX_SHEETS.
 */
export function planGlobalSheetCaptures(sources: SourceLike[], perSheet?: number): GlobalCapture[] {
  const total = totalDuration(sources)
  let times = planContactSheet(total, GLOBAL_MIN_INTERVAL_SECONDS).times
  if (perSheet && perSheet > 0) {
    const recordings = sources.filter((s) => s.duration > 0).length
    const cap = perSheet * Math.max(1, MAX_SHEETS - Math.max(0, recordings - 1))
    if (times.length > cap) times = sampleTimes(total, cap)
  }
  const out: GlobalCapture[] = []
  for (const globalTime of times) {
    const local = globalToLocal(sources, globalTime)
    if (local) out.push({ globalTime, sourceId: local.sourceId, localTime: local.localTime })
  }
  return out
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm --filter studio exec vitest run src/lib/serverFrames.test.ts src/lib/globalSheet.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/lib/serverFrames.ts apps/studio/src/lib/serverFrames.test.ts apps/studio/src/lib/imageSize.ts apps/studio/src/lib/globalSheet.ts apps/studio/src/lib/globalSheet.test.ts
git commit -m "feat(studio): coerce server sheets and frames onto ContactSheet"
```

---

### Task 4: API endpoints and MSW mocks

**Files:**
- Modify: `src/store/studioApi.ts` (`VideoJobKind` at `:35`, and the endpoints after `videoConcatStart` at `:132-134`)
- Modify: `src/mocks/handlers.ts` (new handlers after `/api/video/concat` at `:254-267`; add `'frames'` to the capability `ops` at `:273`)
- Test: `src/mocks/handlers.test.ts` (add cases)

**Interfaces:**
- Consumes: `toServerSheets`, `toServerFrames` from Task 3.
- Produces:
  - `useVideoContactSheetStartMutation()`, which takes `{ sourceUrl: string; projectId: string; times: number[]; labels: string[]; executor?: 'local' | 'remote' }` and returns `StartJobResponse`;
  - `useVideoFramesStartMutation()`, which takes `{ sourceUrl: string; projectId: string; times: number[]; height: number; executor?: 'local' | 'remote' }` and returns `StartJobResponse`;
  - `VideoJobKind` now includes `'video-contact-sheet' | 'video-frames'`.

- [ ] **Step 1: Write the failing mock tests**

Append to `src/mocks/handlers.test.ts`, reusing that file's existing setup (MSW server over `handlers`, and its fetch helper):

```ts
import { toServerSheets, toServerFrames } from '../lib/serverFrames'

describe('server frame mocks', () => {
  async function pollDone(jobId: string): Promise<unknown> {
    for (let i = 0; i < 5; i++) {
      const job = (await (await fetch(`/api/studio/job?id=${jobId}`)).json()) as { status: string; result?: unknown }
      if (job.status === 'done') return job.result
    }
    throw new Error('mock job never finished')
  }

  it('contact-sheet tiles 12 per sheet and coerces through toServerSheets', async () => {
    const times = Array.from({ length: 14 }, (_, i) => i)
    const res = await fetch('/api/video/contact-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: '/api/uploads/projects/p1/source/a.mp4', projectId: 'p1', times, labels: times.map(String) }),
    })
    const { jobId } = (await res.json()) as { jobId: string }
    const sheets = toServerSheets(await pollDone(jobId))
    expect(sheets.map((s) => s.times.length)).toEqual([12, 2])
    expect(sheets[0].url).toMatch(/^\/api\/uploads\/projects\/p1\/thumbnails\/server\//)
  })

  it('frames returns one url per time and coerces through toServerFrames', async () => {
    const res = await fetch('/api/video/frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: '/api/uploads/projects/p1/source/a.mp4', projectId: 'p1', times: [3, 9], height: 720 }),
    })
    const { jobId } = (await res.json()) as { jobId: string }
    const frames = toServerFrames(await pollDone(jobId))
    expect(frames.map((f) => f.time)).toEqual([3, 9])
  })
})
```

If `handlers.test.ts` uses a different request helper or needs `installMswRelativeUrlShim()` for relative URLs, use its pattern rather than bare relative `fetch`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter studio exec vitest run src/mocks/handlers.test.ts`
Expected: FAIL. The unhandled `/api/video/contact-sheet` request errors or 404s.

- [ ] **Step 3: Add the endpoints in `src/store/studioApi.ts`**

Change line 35 to:

```ts
export type VideoJobKind = 'video-extract' | 'video-slice' | 'video-concat' | 'video-contact-sheet' | 'video-frames'
```

Add after the `videoConcatStart` endpoint:

```ts
    // Contact sheets on the server (CE ffmpeg `frames` op with draw + tile): the
    // browser never downloads the source. Result coerced by `toServerSheets`.
    videoContactSheetStart: builder.mutation<
      StartJobResponse,
      { sourceUrl: string; projectId: string; times: number[]; labels: string[]; executor?: 'local' | 'remote' }
    >({
      query: (body) => ({ url: 'api/video/contact-sheet', method: 'POST', body }),
    }),

    // Clean still frames on the server. Result coerced by `toServerFrames`.
    videoFramesStart: builder.mutation<
      StartJobResponse,
      { sourceUrl: string; projectId: string; times: number[]; height: number; executor?: 'local' | 'remote' }
    >({
      query: (body) => ({ url: 'api/video/frames', method: 'POST', body }),
    }),
```

Add `useVideoContactSheetStartMutation` and `useVideoFramesStartMutation` to the hooks destructured from `studioApi` at the bottom of the file, next to `useVideoConcatStartMutation`.

- [ ] **Step 4: Add the mock handlers in `src/mocks/handlers.ts`**

After the `/api/video/concat` handler:

```ts
  // Server contact sheets (CE ffmpeg `frames` + tile). Mirrors the rule's result
  // { sheets: [{ url, times, cols, rows, index, total, bytes }], drawn }: 12 stills per
  // sheet, 3 wide. The bytes are a stub, so <img> reports no natural size offline.
  http.post('/api/video/contact-sheet', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { times?: number[]; labels?: string[]; projectId?: string }
    const times = Array.isArray(body.times) ? body.times : []
    if (times.length === 0 || !Array.isArray(body.labels) || body.labels.length !== times.length) {
      return HttpResponse.json({ error: 'times must be 1-200 non-negative seconds', code: 'BAD_REQUEST' }, { status: 400 })
    }
    const pid = body.projectId ?? 'mock'
    const stamp = Date.now()
    const total = Math.ceil(times.length / 12)
    const sheets = Array.from({ length: total }, (_, i) => {
      const chunk = times.slice(i * 12, i * 12 + 12)
      const key = `projects/${pid}/thumbnails/server/${stamp}/sheet-${String(i + 1).padStart(2, '0')}.jpg`
      const bytes = new TextEncoder().encode('mock-jpeg')
      objectStore.set(key, { body: bytes.buffer as ArrayBuffer, type: 'image/jpeg' })
      const cols = Math.min(chunk.length, 3)
      return { url: `/api/uploads/${key}`, times: chunk, cols, rows: Math.ceil(chunk.length / cols), index: i, total, bytes: bytes.byteLength }
    })
    const jobId = enqueueJob('video-contact-sheet', { sheets, drawn: true, executor: 'local', timings: { totalMs: 1800 } })
    return HttpResponse.json({ jobId, status: 'pending' })
  }),

  // Server frame grabs (CE ffmpeg `frames`, no draw/tile): { frames: [{ time, url }] } in request order.
  http.post('/api/video/frames', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { times?: number[]; projectId?: string }
    const times = Array.isArray(body.times) ? body.times : []
    if (times.length === 0) {
      return HttpResponse.json({ error: 'times must be 1-200 non-negative seconds', code: 'BAD_REQUEST' }, { status: 400 })
    }
    const pid = body.projectId ?? 'mock'
    const stamp = Date.now()
    const frames = times.map((time, i) => {
      const key = `projects/${pid}/frames/server/${stamp}/frame-${String(i + 1).padStart(2, '0')}.jpg`
      const bytes = new TextEncoder().encode('mock-jpeg')
      objectStore.set(key, { body: bytes.buffer as ArrayBuffer, type: 'image/jpeg' })
      return { time, url: `/api/uploads/${key}` }
    })
    const jobId = enqueueJob('video-frames', { frames, executor: 'local', timings: { totalMs: 700 } })
    return HttpResponse.json({ jobId, status: 'pending' })
  }),
```

In the `/api/video/capabilities` handler, change `ops: ['probe', 'extract_audio', 'slice', 'concat']` to `ops: ['probe', 'extract_audio', 'slice', 'concat', 'frames']`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter studio exec vitest run src/mocks/handlers.test.ts && pnpm --filter studio exec tsc -b`
Expected: PASS, with no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/store/studioApi.ts apps/studio/src/mocks/handlers.ts apps/studio/src/mocks/handlers.test.ts
git commit -m "feat(studio): contact-sheet and frames job endpoints with MSW parity"
```

---

### Task 5: Prep contact sheets on the server

**Files:**
- Modify: `src/components/Studio/useScenePipeline.ts`
  - imports at `:41-50` and `:52-71`
  - `runVideoJob` at `:466-480`
  - `generateThumbnails` at `:958-1033`
- Create: `src/components/Studio/useScenePipeline.serverFrames.test.tsx`

**Interfaces:**
- Consumes: Task 3 helpers; Task 4 hooks; the existing `pollJob`, `withBusyRetry`, `getVideoBackend`, `stepExecutor`, `patch`, `setContactSheets`.
- Produces, inside the hook (Tasks 6 and 7 use these):
  - `runVideoJob<T>(label, start, coerce?)`
  - `grabSheets(sourceUrl: string, times: number[], labels: string[]): Promise<ServerSheet[]>`
  - `grabFrames(sourceUrl: string, times: number[], height: number): Promise<ServerFrame[]>`
  - `sheetsFor(got: ServerSheet[], displayTimes: number[], interval: number): Promise<ContactSheet[]>`
- User-visible effects:
  - on success, the `thumbnails` stage detail reads `"<n> frames · <m> sheet(s) (server)"`;
  - when no sheets come back, the stage is in `status: 'error'`.

- [ ] **Step 1: Write the failing hook test**

`src/components/Studio/useScenePipeline.serverFrames.test.tsx`:

```tsx
/**
 * Server frames: prep contact sheets, per-scene sheets, and the blog re-frame
 * helpers go through /api/video/{contact-sheet,frames} (MSW) and never touch
 * the browser capture path. Mirrors useScenePipeline.serverExtract.test.tsx.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import studioReducer, { createProject, addSource, patchSource, patchSourceStage, selectActive } from '../../store/studioSlice'
import { studioApi } from '../../store/studioApi'
import { PER_VIDEO_STAGES } from '../../lib/pipeline'
import { resetVideoBackendForTests } from '../../lib/videoBackend'
import { installMswRelativeUrlShim } from '../../test/mswRequestShim'

const { imageSizeMock } = vi.hoisted(() => ({ imageSizeMock: vi.fn() }))
vi.mock('../../lib/imageSize', () => ({ imageSize: imageSizeMock }))

vi.stubEnv('VITE_MOCK_STUDIO', 'true')
const { handlers } = await import('../../mocks/handlers')
const server = setupServer(...handlers)

import { useScenePipeline } from './useScenePipeline'

type Store = ReturnType<typeof makeStore>

function makeStore() {
  const store = configureStore({
    reducer: { studio: studioReducer, [studioApi.reducerPath]: studioApi.reducer },
    middleware: (g) => g().concat(studioApi.middleware),
  })
  store.dispatch(createProject({ id: 'p1', now: 1 }))
  store.dispatch(addSource({ id: 'src1', fileName: 'rec.mov', duration: 1101 }))
  store.dispatch(
    patchSource({ id: 'src1', patch: { sourceUrl: '/api/uploads/projects/p1/source/rec.mov', duration: 1101 } }),
  )
  for (const stage of PER_VIDEO_STAGES) {
    store.dispatch(patchSourceStage({ id: 'src1', stage, patch: { status: 'done' } }))
  }
  return store
}

const stateOf = (store: Store) => store.getState() as unknown as Parameters<typeof selectActive>[0]
const active = (store: Store) => selectActive(stateOf(store))

function Harness() {
  const pipe = useScenePipeline()
  return (
    <button onClick={() => void pipe.next({ file: new File([], 'x'), src: '', duration: 0 })}>next</button>
  )
}

async function runNext(store: Store) {
  render(
    <Provider store={store}>
      <Harness />
    </Provider>,
  )
  await act(async () => {
    screen.getByText('next').click()
  })
}

installMswRelativeUrlShim()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  resetVideoBackendForTests()
  imageSizeMock.mockResolvedValue({ width: 3 * 1280 + 8, height: 4 * 720 + 10 })
})

describe('prep contact sheets on the server', () => {
  it('asks /api/video/contact-sheet for the planned frames and stores url-only sheets', async () => {
    const seen: { times: number[]; labels: string[] }[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/contact-sheet') seen.push(await request.clone().json())
    })
    const store = makeStore()
    await runNext(store)

    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })

    expect(seen).toHaveLength(1)
    expect(seen[0].times).toHaveLength(120)
    expect(seen[0].labels[0]).toMatch(/^\d+:\d{2}$/)
    const sheets = active(store).contactSheets
    expect(sheets).toHaveLength(10)
    expect(sheets.every((s) => s.dataUrl === '' && s.url?.startsWith('/api/uploads/projects/p1/thumbnails/server/'))).toBe(true)
    expect(sheets[0]).toMatchObject({ cols: 3, rows: 4, cellWidth: 1280, cellHeight: 720, count: 12, index: 0, total: 10 })
    expect(active(store).stageProgress.thumbnails?.detail).toBe('120 frames · 10 sheets (server)')
  }, 15000)

  it('fails the stage, instead of passing it, when the job returns no sheets', async () => {
    server.use(
      http.post('/api/video/contact-sheet', () => HttpResponse.json({ jobId: 'empty-sheets', status: 'pending' })),
      http.get('/api/studio/job', () => HttpResponse.json({ status: 'done', kind: 'video-contact-sheet', result: { sheets: [] } })),
    )
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('error'), { timeout: 12000 })
    expect(active(store).stageProgress.thumbnails?.detail).toMatch(/without any sheets/)
    expect(active(store).contactSheets).toEqual([])
  }, 15000)
})
```

If `patchSourceStage`, `PER_VIDEO_STAGES` or `failActiveStage` behave differently from what these tests assume (for example, `stageError()` prefixes the message), read `useScenePipeline.ts` around `next()` at `:1201-1229` and `stageError`, then adjust only the expected detail string.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter studio exec vitest run src/components/Studio/useScenePipeline.serverFrames.test.tsx`
Expected: FAIL. With no contact-sheet request, the browser path runs in jsdom, captures nothing, and ends with `'no frames sampled'`.

- [ ] **Step 3: Generalise `runVideoJob` and add the grab helpers**

In `useScenePipeline.ts`:

1. Add the imports:

```ts
import {
  SERVER_SHEET_CELLS,
  toServerSheets,
  toServerFrames,
  sheetLabels,
  toContactSheets,
  restampSheets,
  type ServerSheet,
  type ServerFrame,
} from '../../lib/serverFrames'
import { imageSize } from '../../lib/imageSize'
```

2. Add `useVideoContactSheetStartMutation` and `useVideoFramesStartMutation` to the `../../store/studioApi` import. Under `const [videoConcatStartReq] = useVideoConcatStartMutation()`, add:

```ts
  const [videoContactSheetStartReq] = useVideoContactSheetStartMutation()
  const [videoFramesStartReq] = useVideoFramesStartMutation()
```

3. Replace `runVideoJob` (`:466-480`) with:

```ts
  const runVideoJob = useCallback(
    <T = VideoResult>(
      label: string,
      start: () => Promise<StartJobResponse>,
      coerce: (raw: unknown) => T = toVideoResult as unknown as (raw: unknown) => T,
    ): Promise<T> =>
      withBusyRetry(
        async () => {
          const { jobId } = await start()
          const job = await pollJob(jobId, { timeoutMs: VIDEO_POLL_TIMEOUT_MS })
          return coerce(job.result)
        },
        {
          onRetry: ({ attempt, delayMs, error }) =>
            console.warn(`[studio] ${label}: server busy — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}): ${error.message}`),
        },
      ),
    [pollJob],
  )

  // Server frame grabs (CE ffmpeg `frames`). The executor follows the video
  // backend picker, like slice/concat/extract.
  const grabSheets = useCallback(
    (sourceUrl: string, times: number[], labels: string[]): Promise<ServerSheet[]> =>
      runVideoJob(
        'contact sheets',
        async () =>
          videoContactSheetStartReq({
            sourceUrl,
            projectId: activeProjectId ?? '',
            times,
            labels,
            executor: stepExecutor(await getVideoBackend()),
          }).unwrap(),
        toServerSheets,
      ),
    [runVideoJob, videoContactSheetStartReq, activeProjectId],
  )

  const grabFrames = useCallback(
    (sourceUrl: string, times: number[], height: number): Promise<ServerFrame[]> =>
      runVideoJob(
        'frames',
        async () =>
          videoFramesStartReq({
            sourceUrl,
            projectId: activeProjectId ?? '',
            times,
            height,
            executor: stepExecutor(await getVideoBackend()),
          }).unwrap(),
        toServerFrames,
      ),
    [runVideoJob, videoFramesStartReq, activeProjectId],
  )

  // Read each sheet JPEG's natural size once, so the cut editor's sprite crop has
  // cell geometry, then map onto ContactSheet.
  const sheetsFor = useCallback(
    async (got: ServerSheet[], displayTimes: number[], interval: number) => {
      const sizes = await Promise.all(got.map((s) => imageSize(s.url)))
      return toContactSheets(got, sizes, displayTimes, interval)
    },
    [],
  )
```

Check `stepExecutor`'s parameter type in `src/lib/videoBackend.ts:89`. It must accept whatever `getVideoBackend()` resolves to; `processSource` already calls it that way at `:1126`.

- [ ] **Step 4: Replace `generateThumbnails` (`:952-1033`, including its leading comment)**

```ts
  // Stage ④ — the director's contact sheets, built on the server (CE ffmpeg
  // `frames` + tile via /api/video/contact-sheet). Frames are planned on the
  // COMBINED timeline (story 09c), grabbed per source at LOCAL times, and labelled
  // and reported with GLOBAL times so the director reads one continuous timeline.
  // The browser never downloads a recording. No sheets back is a failure, never a
  // silent "done".
  const generateThumbnails = useCallback(
    async () => {
      patch('thumbnails', { status: 'active' })
      const ordered = [...sources].sort((a, b) => a.order - b.order)
      const captures = planGlobalSheetCaptures(
        ordered.map((s) => ({ id: s.id, duration: s.duration })),
        SERVER_SHEET_CELLS,
      )
      const interval = captures.length > 1 ? captures[1].globalTime - captures[0].globalTime : 0
      const sheets: ContactSheet[] = []
      for (const src of ordered) {
        const mine = captures.filter((c) => c.sourceId === src.id)
        if (mine.length === 0 || !src.sourceUrl) continue
        const globalTimes = mine.map((c) => c.globalTime)
        const got = await grabSheets(src.sourceUrl, mine.map((c) => c.localTime), sheetLabels(globalTimes))
        sheets.push(...(await sheetsFor(got, globalTimes, interval)))
      }
      if (sheets.length === 0) {
        throw new Error('No contact sheets were made — check that every recording finished uploading.')
      }
      const stamped = restampSheets(sheets)
      dispatch(setContactSheets(stamped))
      const frameCount = stamped.reduce((n, s) => n + s.count, 0)
      patch('thumbnails', {
        status: 'done',
        detail: `${frameCount} frames · ${stamped.length} sheet${stamped.length === 1 ? '' : 's'} (server)`,
      })
    },
    [patch, dispatch, sources, grabSheets, sheetsFor],
  )
```

`next()` already turns a throw into `failActiveStage(stageError(e))`, so errors land on the stage. Leave `setPendingSheets` and the `pendingSheets` state alone for now; Task 8 removes them.

- [ ] **Step 5: Run the test and the whole suite**

Run: `pnpm --filter studio exec vitest run src/components/Studio/useScenePipeline.serverFrames.test.tsx && pnpm --filter studio test:run`
Expected: the new tests PASS and the full suite stays green. Lint may flag unused imports such as `composeContactSheet`, `CONTACT_SHEET_SUPERSAMPLE`, `chunk` or `cellsPerSheet`. Remove only the ones no longer referenced in the file.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/components/Studio/useScenePipeline.ts apps/studio/src/components/Studio/useScenePipeline.serverFrames.test.tsx
git commit -m "feat(studio): build prep contact sheets on the server and fail loudly when none come back"
```

---

### Task 6: Per-scene sheets on the server, in the ffmpeg lane

**Files:**
- Modify: `src/components/Studio/useScenePipeline.ts` (`generateSceneSheets` at `:1233-1275`)
- Modify: `src/lib/autoBuild.ts` (the `Lane`, `STEP_LANE` and `DEFAULT_LANE_CAPS` block at `:84-105`, and `laneLoad` at `:165`)
- Modify: `src/lib/autoBuild.test.ts` (tests at `:269-289`)
- Test: `src/components/Studio/useScenePipeline.serverFrames.test.tsx` (add a case)

**Interfaces:**
- Consumes: `grabSheets` and `sheetsFor` from Task 5; `planSceneContactSheet` and `clockLabel` from `src/lib/contactSheet.ts`.
- Produces:
  - `STEP_LANE.sheets === 'ffmpeg'`;
  - `Lane = 'ffmpeg' | 'refine'`;
  - `DEFAULT_LANE_CAPS = { ffmpeg: 1, refine: 1 }`.

- [ ] **Step 1: Update the lane tests so they fail**

In `src/lib/autoBuild.test.ts`, replace the three tests at `:269-289` with:

```ts
  it('maps cut, sheets and assemble to the ffmpeg lane and refine to its own', () => {
    // Sheets are a server ffmpeg job now, so on the Local executor they share
    // the backend's single slot with cut and assemble.
    expect(STEP_LANE).toEqual({ cut: 'ffmpeg', assemble: 'ffmpeg', refine: 'refine', sheets: 'ffmpeg' })
  })

  it('offers only one ffmpeg step: assemble of the earlier scene wins over cut of a later one', () => {
    const actions = nextActions([atAssemble('s1', 0), atCut('s2', 1)], [])
    expect(stepsOf(actions)).toEqual(['s1:assemble'])
  })

  it('overlaps the ffmpeg and refine lanes across scenes; sheets wait for the ffmpeg slot', () => {
    const actions = nextActions([atAssemble('s1', 0), atRefine('s2', 1), atSheets('s3', 2)], [])
    expect(stepsOf(actions)).toEqual(['s1:assemble', 's2:refine'])
  })

  it('blocks a lane already in flight', () => {
    const inFlight: ActiveStep[] = [{ sceneId: 's1', stepId: 'assemble' }]
    const actions = nextActions([atAssemble('s1', 0), atCut('s2', 1), atSheets('s3', 2)], inFlight)
    // Both s2's cut and s3's sheets need the busy ffmpeg lane.
    expect(stepsOf(actions)).toEqual([])
  })
```

Search the same file for any `laneCapsFor(...)` or `DEFAULT_LANE_CAPS` expectation containing `sheets: 1`, and remove the `sheets` key from those expected objects.

- [ ] **Step 2: Run the lane tests and confirm they fail**

Run: `pnpm --filter studio exec vitest run src/lib/autoBuild.test.ts`
Expected: FAIL, because `sheets` still maps to `'sheets'`.

- [ ] **Step 3: Move sheets into the ffmpeg lane in `src/lib/autoBuild.ts`**

Replace lines `:84-105` with:

```ts
export type Lane = 'ffmpeg' | 'refine'

/**
 * Which shared resource each step occupies. cut, sheets and assemble all run
 * ffmpeg — on the wasm backend that's the ONE ffmpeg.wasm instance, and on CE's
 * Local executor it's the backend's single ffmpeg slot, so the lane holds
 * capacity 1 there. On the Remote executor each job is its own Cloud Run
 * instance, so the lane widens to `ffmpegLaneCapacity` (spec P6). refine is a
 * server job the browser merely polls, and stays at 1.
 */
export const STEP_LANE: Record<AutoStepId, Lane> = {
  cut: 'ffmpeg',
  assemble: 'ffmpeg',
  refine: 'refine',
  sheets: 'ffmpeg',
}

/** How many steps each lane may hold at once. */
export type LaneCaps = Record<Lane, number>

export const DEFAULT_LANE_CAPS: LaneCaps = { ffmpeg: 1, refine: 1 }
```

At `:165`, change `const laneLoad: Record<Lane, number> = { ffmpeg: 0, refine: 0, sheets: 0 }` to `const laneLoad: Record<Lane, number> = { ffmpeg: 0, refine: 0 }`.

Run `grep -rn "'sheets'" apps/studio/src/components/Studio/useAutoBuild.ts apps/studio/src/components/Studio/AutoBuildBoard.tsx`. If any code indexes a lane record by `'sheets'` (as opposed to the step id), point it at the step's lane through `STEP_LANE`.

- [ ] **Step 4: Add the failing per-scene hook test**

Append to `useScenePipeline.serverFrames.test.tsx`:

```tsx
import { setScenes } from '../../store/studioSlice'
import type { Scene } from '../../lib/scenes'

function SheetsHarness({ id }: { id: string }) {
  const pipe = useScenePipeline()
  return <button onClick={() => void pipe.generateSceneSheets(id)}>sheets</button>
}

describe('per-scene sheets on the server', () => {
  it('grabs the scene window through /api/video/contact-sheet and patches url-only sheets', async () => {
    const bodies: { times: number[]; labels: string[] }[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/contact-sheet') bodies.push(await request.clone().json())
    })
    const store = makeStore()
    store.dispatch(setScenes([{ id: 'sc1', index: 0, title: 'Intro', start: 60, end: 90, cuts: [] } as unknown as Scene]))
    render(
      <Provider store={store}>
        <SheetsHarness id="sc1" />
      </Provider>,
    )
    await act(async () => {
      screen.getByText('sheets').click()
    })
    await waitFor(() => expect(active(store).scenes[0].sheets?.length ?? 0).toBeGreaterThan(0), { timeout: 12000 })
    expect(bodies[0].times[0]).toBeGreaterThanOrEqual(60)
    expect(bodies[0].times.at(-1)!).toBeLessThan(90)
    expect(bodies[0].labels[0]).toBe('1:00')
    expect(active(store).scenes[0].sheets!.every((s) => s.url?.includes('/thumbnails/server/'))).toBe(true)
  }, 15000)
})
```

If `setScenes` or `sourceForScene` needs more `Scene` fields, such as `sourceId`, copy them from an existing fixture in `src/components/Studio/useAutoBuild.test.tsx` rather than inventing them.

- [ ] **Step 5: Replace `generateSceneSheets` (`:1233-1275`, including its leading comment)**

Add `planSceneContactSheet` to the `../../lib/contactSheet` import. Then:

```ts
  // Button 1: DENSE contact sheets for just this scene's window, built on the
  // server (CE ffmpeg `frames` + tile). The times are the scene's own seconds in
  // its source recording, the same times the browser version captured, and they
  // are used as the labels too. Persisted url-only, like the prep sheets.
  const generateSceneSheets = useCallback(
    async (id: string) => {
      if (sheetingIds.has(id) || refiningIds.has(id)) return
      const scene = scenes.find((s) => s.id === id)
      const src = scene && sourceForScene(sources, scene)
      if (!scene || !src?.sourceUrl) return
      setSheetingIds((s) => toggleId(s, id, true))
      setSceneErrorFor(id, null)
      try {
        const plan = planSceneContactSheet(scene.start, scene.end)
        if (plan.times.length === 0) throw new Error('This scene is too short for a contact sheet.')
        const got = await grabSheets(src.sourceUrl, plan.times, sheetLabels(plan.times))
        patchScene(id, { sheets: await sheetsFor(got, plan.times, plan.interval) })
      } catch (e) {
        setSceneErrorFor(id, stageError(e))
      } finally {
        setSheetingIds((s) => toggleId(s, id, false))
      }
    },
    [sheetingIds, refiningIds, scenes, sources, grabSheets, sheetsFor, patchScene, setSceneErrorFor],
  )
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter studio exec vitest run src/lib/autoBuild.test.ts src/components/Studio/useScenePipeline.serverFrames.test.tsx src/components/Studio/useAutoBuild.test.tsx`
Expected: PASS. If `useAutoBuild.test.tsx` asserted that sheets and cut run at the same time, update that expectation to the new serial ordering; the lane change is the intended behaviour.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/lib/autoBuild.ts apps/studio/src/lib/autoBuild.test.ts apps/studio/src/components/Studio/useScenePipeline.ts apps/studio/src/components/Studio/useScenePipeline.serverFrames.test.tsx apps/studio/src/components/Studio/useAutoBuild.test.tsx
git commit -m "feat(studio): per-scene contact sheets on the server, scheduled in the ffmpeg lane"
```

---

### Task 7: Scene card thumbs and blog frames on the server

**Files:**
- Modify: `src/components/Studio/useScenePipeline.ts`:
  - `completeDirectorJob` at `:490-547`
  - `runDirector` at `:1041-1058`
  - the resume effect at `:852`
  - `materializeBlogImages` at `:619-684`
  - the blog clip cache plus `captureBlogSiblings`, `captureBlogPreview` and `reframeBlogImage` at `:686-814`
- Test: `src/components/Studio/useScenePipeline.serverFrames.test.tsx` (add cases)

**Interfaces:**
- Consumes: `grabFrames` from Task 5, and `sourceForScene`, `globalToLocal` and `totalDuration` (already imported).
- Produces:
  - `completeDirectorJob(jobId: string)`, which loses the `videoSrc` parameter;
  - `captureBlogSiblings(time): Promise<{ time: number; thumb: string }[]>`, where `thumb` is now an `/api/uploads/...` URL at 720px;
  - `captureBlogPreview(time): Promise<string>`, which returns the cached candidate URL or one grabbed frame;
  - `reframeBlogImage(oldUrl, time): Promise<boolean>`, unchanged in signature.
  - Constants: `SCENE_THUMB_HEIGHT = 180`, `BLOG_FRAME_HEIGHT = 1080`, `BLOG_PREVIEW_HEIGHT = 720`.

- [ ] **Step 1: Write the failing blog re-frame tests**

Append to `useScenePipeline.serverFrames.test.tsx`:

```tsx
function BlogHarness({ onReady }: { onReady: (p: ReturnType<typeof useScenePipeline>) => void }) {
  const pipe = useScenePipeline()
  onReady(pipe)
  return null
}

describe('blog re-frame on the server', () => {
  it('fetches the candidate strip as server frames and reuses them as previews', async () => {
    const heights: number[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/frames') heights.push((await request.clone().json()).height)
    })
    const store = makeStore()
    let pipe!: ReturnType<typeof useScenePipeline>
    render(
      <Provider store={store}>
        <BlogHarness onReady={(p) => (pipe = p)} />
      </Provider>,
    )
    let strip: { time: number; thumb: string }[] = []
    await act(async () => {
      strip = await pipe.captureBlogSiblings(300)
    })
    expect(strip.length).toBeGreaterThan(0)
    expect(strip.every((s) => s.thumb.startsWith('/api/uploads/projects/p1/frames/server/'))).toBe(true)
    expect(heights).toEqual([720])

    let preview = ''
    await act(async () => {
      preview = await pipe.captureBlogPreview(strip[1].time)
    })
    expect(preview).toBe(strip[1].thumb)
    expect(heights).toEqual([720]) // cached: no second job
  }, 15000)

  it('re-frames at full height and swaps the served url into the post', async () => {
    const store = makeStore()
    let pipe!: ReturnType<typeof useScenePipeline>
    render(
      <Provider store={store}>
        <BlogHarness onReady={(p) => (pipe = p)} />
      </Provider>,
    )
    let ok = false
    await act(async () => {
      ok = await pipe.reframeBlogImage('/api/uploads/blog/old.jpg', 42)
    })
    expect(ok).toBe(true)
  }, 15000)
})
```

`reframeBlogImageAction` changes the stored post only if it contains `oldUrl`, so this test only asserts that the job path resolves to true. If the slice's reducer needs a blog in state to accept the action, seed one with `setBlogResult({ markdown: '![a](/api/uploads/blog/old.jpg)', frames: [{ url: '/api/uploads/blog/old.jpg', time: 40 }] })`, matching the `BlogImageRef` shape in `src/lib/blog.ts`, and assert the new URL is in `active(store).blog`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter studio exec vitest run src/components/Studio/useScenePipeline.serverFrames.test.tsx -t "blog re-frame"`
Expected: FAIL. The browser path tries to fetch the source blob, and no `/api/video/frames` request is made.

- [ ] **Step 3: Scene card thumbs**

Near the other module constants (after `VIDEO_POLL_TIMEOUT_MS`), add:

```ts
/** Scene card art height (px). Card thumbs render small; 180 stays crisp on retina. */
const SCENE_THUMB_HEIGHT = 180
/** Blog hero frames (px). CE scales to this height and does not cap at the source,
 *  so 1080 never upscales a 1080p recording. */
const BLOG_FRAME_HEIGHT = 1080
/** Blog re-frame candidates (px): shown small in the strip, and large as the preview. */
const BLOG_PREVIEW_HEIGHT = 720
```

In `completeDirectorJob`:
- change the signature to `async (jobId: string) =>`;
- update the doc comment so it no longer mentions `videoSrc`;
- replace the thumbnail block at `:520-533` with:

```ts
        // Scene-card art, best-effort and AFTER the commit: one midpoint frame per
        // scene, grabbed on the server from that scene's own source.
        const bySource = new Map<string, { sceneId: string; time: number }[]>()
        for (const s of built) {
          const src = sourceForScene(sources, s)
          if (!src?.sourceUrl) continue
          const arr = bySource.get(src.sourceUrl) ?? []
          arr.push({ sceneId: s.id, time: (s.start + s.end) / 2 })
          bySource.set(src.sourceUrl, arr)
        }
        for (const [sourceUrl, wants] of bySource) {
          try {
            const frames = await grabFrames(sourceUrl, wants.map((w) => w.time), SCENE_THUMB_HEIGHT)
            wants.forEach((w, i) => {
              if (frames[i]) patchScene(w.sceneId, { thumb: frames[i].url })
            })
          } catch {
            // card art is optional
          }
        }
```

Add `grabFrames` to its dependency array. Then:
- at `:1055`, change `await completeDirectorJob(jobId, src)` to `await completeDirectorJob(jobId)`, and change `runDirector`'s parameter from `async ({ src }: StepContext) =>` to `async (_ctx: StepContext) =>`. If lint rejects an unused parameter, use `async () =>` and keep `rerunDirector` calling `runDirector()`.
- at `:852`, change `void completeDirectorJob(scenesJobId, sourceUrl)` to `void completeDirectorJob(scenesJobId)`.

- [ ] **Step 4: Blog images**

Replace the body of `materializeBlogImages`'s per-source loop (`:647-677`) with:

```ts
      const urlByTime = new Map<number, string>()
      for (const [sourceId, caps] of bySource) {
        const src = sources.find((s) => s.id === sourceId)
        if (!src?.sourceUrl) continue
        try {
          // Clean, label-free frames grabbed on the server (ADR-0002: re-capture from
          // the source, never crop a sheet). Served straight from the bucket, no re-upload.
          const frames = await grabFrames(src.sourceUrl, caps.map((c) => c.localTime), BLOG_FRAME_HEIGHT)
          caps.forEach((c, i) => {
            if (frames[i]) urlByTime.set(c.time, frames[i].url)
          })
        } catch {
          // this source's frames are left out, never a broken image
        }
      }
```

Update its `useCallback` dependencies to `[sources, grabFrames]`, and update the doc comment: frames come from the server and nothing uploads.

Replace everything from the `// ---- Re-framing a blog image` comment (`:686`) through the end of `reframeBlogImage` (`:814`) with:

```ts
  // ---- Re-framing a blog image to a nearby moment (issue #91) --------------
  //
  // The producer can nudge a bad AI-picked frame to a sibling timestamp. The
  // candidate strip is ONE server frame job at preview size; each candidate's URL
  // is both its strip thumb and its large preview, so previews are instant.
  const blogPreviewCache = useRef(new Map<number, string>())

  /** Candidate frames around a blog image's global time, grabbed on the server. */
  const captureBlogSiblings = useCallback(
    async (time: number): Promise<{ time: number; thumb: string }[]> => {
      const lite = sources.map((s) => ({ id: s.id, duration: s.duration }))
      const times = planBlogSiblings(time, totalDuration(lite))
      const bySource = new Map<string, number[]>()
      const localByGlobal = new Map<number, number>()
      for (const t of times) {
        const loc = globalToLocal(lite, t)
        if (!loc) continue
        localByGlobal.set(t, loc.localTime)
        const arr = bySource.get(loc.sourceId) ?? []
        arr.push(t)
        bySource.set(loc.sourceId, arr)
      }
      blogPreviewCache.current = new Map()
      for (const [sourceId, ts] of bySource) {
        const src = sources.find((s) => s.id === sourceId)
        if (!src?.sourceUrl) continue
        try {
          const frames = await grabFrames(src.sourceUrl, ts.map((t) => localByGlobal.get(t) ?? 0), BLOG_PREVIEW_HEIGHT)
          ts.forEach((t, i) => {
            if (frames[i]) blogPreviewCache.current.set(t, frames[i].url)
          })
        } catch {
          // a source whose frames fail is left out of the strip
        }
      }
      return times
        .map((t) => ({ time: t, thumb: blogPreviewCache.current.get(t) ?? '' }))
        .filter((s) => s.thumb)
    },
    [sources, grabFrames],
  )

  /** The large preview for a candidate: its cached strip frame, or one server grab. '' on failure. */
  const captureBlogPreview = useCallback(
    async (time: number): Promise<string> => {
      const cached = blogPreviewCache.current.get(time)
      if (cached) return cached
      const lite = sources.map((s) => ({ id: s.id, duration: s.duration }))
      const loc = globalToLocal(lite, time)
      const src = loc && sources.find((s) => s.id === loc.sourceId)
      if (!loc || !src?.sourceUrl) return ''
      try {
        const [frame] = await grabFrames(src.sourceUrl, [loc.localTime], BLOG_PREVIEW_HEIGHT)
        return frame?.url ?? ''
      } catch {
        return ''
      }
    },
    [sources, grabFrames],
  )

  /** Re-grab a clean full-height frame at the picked second and swap it into the post. */
  const reframeBlogImage = useCallback(
    async (oldUrl: string, time: number): Promise<boolean> => {
      const lite = sources.map((s) => ({ id: s.id, duration: s.duration }))
      const loc = globalToLocal(lite, time)
      const src = loc && sources.find((s) => s.id === loc.sourceId)
      if (!loc || !src?.sourceUrl) return false
      try {
        const [frame] = await grabFrames(src.sourceUrl, [loc.localTime], BLOG_FRAME_HEIGHT)
        if (!frame) return false
        dispatch(reframeBlogImageAction({ oldUrl, newUrl: frame.url, time }))
        return true
      } catch {
        return false
      }
    },
    [sources, grabFrames, dispatch],
  )
```

Remove `blogReframeFileName` from the `../../lib/blog` import if nothing else in the file uses it. Leave the function in `lib/blog.ts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter studio exec vitest run src/components/Studio/useScenePipeline.serverFrames.test.tsx && pnpm --filter studio test:run`
Expected: PASS. `BlogCard.test.tsx` and `MarkdownPreview.test.tsx` stub these callbacks, so they need no changes.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/components/Studio/useScenePipeline.ts apps/studio/src/components/Studio/useScenePipeline.serverFrames.test.tsx
git commit -m "feat(studio): scene card thumbs and blog frames grabbed on the server"
```

---

### Task 8: Delete the browser capture path, update docs, full verification

**Files:**
- Modify: `src/lib/frames.ts`
  - keep only `CONTACT_SHEET_CELL`, `CONTACT_SHEET_SUPERSAMPLE` (if still imported anywhere), `MAX_SHEET_BYTES` (if still imported anywhere) and the `ContactSheet` type;
  - delete `captureFrames`, `FrameEncoding`, `FRAME_CAPTURE_STALL_MS`, `captureFramesAt`, `loadImage`, `dataUrlBytes`, `encodeUnderBudget`, `composeContactSheet`, `captureContactSheet`, `captureSceneContactSheet` and `captureSheetsForPlan`.
- Delete: `src/lib/frames.test.ts` (it only covers `captureFramesAt`)
- Delete: `src/components/Studio/Filmstrip.tsx` (no importers)
- Modify: `src/components/Studio/useScenePipeline.ts`
  - remove the `pendingSheets` state (`:365-373`) and `setPendingSheets([])` in `reset` (`:398`);
  - `contactSheets` becomes `persistedSheets`;
  - remove the now-unused imports.
- Modify: `apps/studio/CLAUDE.md` (the locked pipeline, stage 4, and the Backend paragraph)
- Modify: `docs/superpowers/specs/2026-09-13-studio-server-video-design.md` (only if the implementation diverged from it)

**Interfaces:**
- Consumes: everything above.
- Produces: no browser-side frame capture remains. `grep -rn "captureFramesAt\|composeContactSheet\|captureSceneContactSheet" apps/studio/src` returns nothing.

- [ ] **Step 1: Delete the code**

Delete the functions listed above from `src/lib/frames.ts`. Rewrite the module's top comment to:

```ts
/**
 * The contact-sheet shape shared by the director, refiner and cut-editor
 * filmstrip. Sheets are built on the server (CE ffmpeg `frames` via
 * /api/video/contact-sheet) and mapped onto this type by `serverFrames.ts`.
 */
```

Then delete `src/lib/frames.test.ts` and `src/components/Studio/Filmstrip.tsx`. In `useScenePipeline.ts`, remove `pendingSheets` / `setPendingSheets` and set `const contactSheets = persistedSheets`.

- [ ] **Step 2: Confirm nothing references the deleted code**

Run: `grep -rn "captureFramesAt\|captureFrames\b\|composeContactSheet\|captureSceneContactSheet\|captureContactSheet\|FRAME_CAPTURE_STALL_MS\|pendingSheets\|Filmstrip'" apps/studio/src apps/studio/headless`
Expected: no matches outside comments. Update any comment that still describes browser capture, for example in `CutEditor.tsx` or `filmstrip.ts`.

- [ ] **Step 3: Update `apps/studio/CLAUDE.md`**

In "The locked pipeline", replace stage 4 with:

```markdown
4. **Contact sheet** — interval-sampled frames tiled into timestamped sheets **on the server**
   (`/api/video/contact-sheet`, CE's ffmpeg `frames` op with draw + tile, CE ≥ 0.4.35)
```

In the Backend paragraph, change `(/api/video/{capabilities,slice,concat,extract-audio}, CE's ffmpeg_handler)` to `(/api/video/{capabilities,slice,concat,extract-audio,contact-sheet,frames}, CE's ffmpeg_handler)`. After that sentence, add: `Contact sheets, scene card thumbs and blog frames are server-only (no browser fallback; CE ≥ 0.4.35 for the frames op).`

- [ ] **Step 4: Full verification**

Run each command and read its output:

```bash
pnpm --filter studio lint
pnpm --filter studio build
pnpm --filter studio test:run
npx --yes bffless@^0.2.0 rules test apps/studio/.bffless/proxy-rules/studio
npx --yes bffless@^0.2.0 rules validate apps/studio/.bffless/proxy-rules/studio
```

Expected: lint clean; the build succeeds; every test passes (the baseline was 718, so expect roughly that plus the new tests minus the 4 deleted `captureFramesAt` tests); 31 rule cases pass (15 existing, 10 from Task 1, 6 from Task 2); validation reports no errors.

- [ ] **Step 5: Commit**

```bash
git add -A apps/studio docs/superpowers
git commit -m "refactor(studio): remove browser frame capture now that sheets and frames run on the server"
```

---

## After the plan (controller, not a task)

1. Review the whole branch diff against the spec.
2. Ask the person before pushing and opening the PR. The PR's preview deploy dry-runs the rules; merging pushes them to j5s.
3. After merge, walk it on studio.j5s.dev with a member login: run prep on a long `.mov` and check `studio_jobs` for a done `video-contact-sheet` job.
4. studio.bffless.dev gets the change only through a catalog release and an app update (Admin → Apps). Tell the person.
