# Changelog

## [1.6.0](https://github.com/bffless/apps/compare/workflow-headless-v1.5.0...workflow-headless-v1.6.0) (2026-09-11)


### Features

* **workflow-headless:** carry the drive nonce on every request the driven page makes ([#664](https://github.com/bffless/apps/issues/664)) ([0c4297b](https://github.com/bffless/apps/commit/0c4297bb665d8cf8665160e0b6f9b2345848ce7c))

## [1.5.0](https://github.com/bffless/apps/compare/workflow-headless-v1.4.0...workflow-headless-v1.5.0) (2026-09-09)


### Features

* **workflow-headless:** a file input given a URL wrapped in an object is treated as that URL ([#640](https://github.com/bffless/apps/issues/640)) ([7a95aea](https://github.com/bffless/apps/commit/7a95aeaee29a62bfe6c5ad49a92419dc321ef89b))

## [1.4.0](https://github.com/bffless/apps/compare/workflow-headless-v1.3.0...workflow-headless-v1.4.0) (2026-09-08)


### Features

* **workflow-headless:** a file input may be an https:// URL over the MCP endpoint ([#637](https://github.com/bffless/apps/issues/637)) ([00bfb61](https://github.com/bffless/apps/commit/00bfb611c84c0095c1992f93f90768a0bc420629))

## [1.3.0](https://github.com/bffless/apps/compare/workflow-headless-v1.2.0...workflow-headless-v1.3.0) (2026-09-06)


### Features

* **workflow-headless:** sign in from an app token through CE's session exchange — no email/password in CI ([#588](https://github.com/bffless/apps/issues/588)) ([#622](https://github.com/bffless/apps/issues/622)) ([09e39eb](https://github.com/bffless/apps/commit/09e39eb22bba613c31ad2559ccf2754fa5aa313e))

## [1.2.0](https://github.com/bffless/apps/compare/workflow-headless-v1.1.0...workflow-headless-v1.2.0) (2026-09-05)


### Features

* **workflow-agent-tools:** workflow.start and workflow.resume describe what the MCP endpoint does — dispatch the implementation's headless driver; run/drive joins RULE_SCOPES ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-cli:** --driver-repo on index and publish (default GITHUB_REPOSITORY); init writes .github/workflows/workflow-drive.yml, the repository_dispatch the harness's drive rule sends ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-headless:** --wait park, --run-id, --grace and the resume verb — a parked run exits 0 and a fresh driver picks it up; exit 5 when another tab or job holds the lease ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-lint:** index.json declares its driver repo (driver.repo) ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow:** driven runs — a headless run parks at a step that needs a person (wait=park, runId=, resume=1); the run/drive rule dispatches the implementation's driver; workflow.start and workflow.resume served over the MCP endpoint, submitStep re-dispatches, status answers pending ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))

## [1.1.0](https://github.com/bffless/apps/compare/workflow-headless-v1.0.2...workflow-headless-v1.1.0) (2026-09-05)


### Features

* **workflow-headless:** page-tools helpers — listPageTools, waitForPageTools and callPageTool drive the harness's WebMCP catalog through page.evaluate ([b3ee012](https://github.com/bffless/apps/commit/b3ee0127c01f5309fc5f31164c3a626465475f53))
* **workflow-headless:** WORKFLOW_APP_TOKEN — an app token sent as Authorization: Bearer on every /api/workflow/* call the driver makes; wins over WORKFLOW_TOKEN ([b3ee012](https://github.com/bffless/apps/commit/b3ee0127c01f5309fc5f31164c3a626465475f53))

## [1.0.2](https://github.com/bffless/apps/compare/workflow-headless-v1.0.1...workflow-headless-v1.0.2) (2026-08-31)


### Bug Fixes

* **workflow:** flush the record seal at pagehide; walks wait for the sealed record before goto ([#552](https://github.com/bffless/apps/issues/552)) ([8b918d9](https://github.com/bffless/apps/commit/8b918d98769a1e35dae2e538164be230f318850b))

## [1.0.1](https://github.com/bffless/apps/compare/workflow-headless-v1.0.0...workflow-headless-v1.0.1) (2026-08-31)


### Bug Fixes

* **workflow-headless:** wait for the run record to seal before closing the browser ([#542](https://github.com/bffless/apps/issues/542)) ([106bde0](https://github.com/bffless/apps/commit/106bde0161a78928c491e477df2c700089beb402))

## 1.0.0 (2026-08-28)


### Features

* **workflow:** headless execution and the driver CLI ([#410](https://github.com/bffless/apps/issues/410)) ([d994238](https://github.com/bffless/apps/commit/d994238bfff13c11fe0db8538e6742d800d3aee2))


### Bug Fixes

* **workflow-headless:** say what the browser is looking at when login fails ([#413](https://github.com/bffless/apps/issues/413)) ([9279a40](https://github.com/bffless/apps/commit/9279a404df92ac3fcc245ee98da79ee9bff07721))
