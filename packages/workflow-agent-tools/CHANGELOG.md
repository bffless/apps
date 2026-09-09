# Changelog

## [1.3.1](https://github.com/bffless/apps/compare/workflow-agent-tools-v1.3.0...workflow-agent-tools-v1.3.1) (2026-09-09)


### Bug Fixes

* **workflow:** a pending run's status answer carries the endpoint's clock ([#655](https://github.com/bffless/apps/issues/655)) ([dbdae29](https://github.com/bffless/apps/commit/dbdae298b3927815a8a80d25e9916fd42224f317))

## [1.3.0](https://github.com/bffless/apps/compare/workflow-agent-tools-v1.2.0...workflow-agent-tools-v1.3.0) (2026-09-09)


### Features

* **workflow-headless:** a file input given a URL wrapped in an object is treated as that URL ([#640](https://github.com/bffless/apps/issues/640)) ([7a95aea](https://github.com/bffless/apps/commit/7a95aeaee29a62bfe6c5ad49a92419dc321ef89b))

## [1.2.0](https://github.com/bffless/apps/compare/workflow-agent-tools-v1.1.1...workflow-agent-tools-v1.2.0) (2026-09-08)


### Features

* **workflow-headless:** a file input may be an https:// URL over the MCP endpoint ([#637](https://github.com/bffless/apps/issues/637)) ([00bfb61](https://github.com/bffless/apps/commit/00bfb611c84c0095c1992f93f90768a0bc420629))

## [1.1.1](https://github.com/bffless/apps/compare/workflow-agent-tools-v1.1.0...workflow-agent-tools-v1.1.1) (2026-09-07)


### Bug Fixes

* **workflow:** file refs and the server instructions point MCP callers at workflow.sign ([#627](https://github.com/bffless/apps/issues/627)) ([#628](https://github.com/bffless/apps/issues/628)) ([2a36494](https://github.com/bffless/apps/commit/2a3649483340dc25208c4811adffe27151823519))

## [1.1.0](https://github.com/bffless/apps/compare/workflow-agent-tools-v1.0.0...workflow-agent-tools-v1.1.0) (2026-09-05)


### Features

* **workflow-agent-tools:** workflow.start and workflow.resume describe what the MCP endpoint does — dispatch the implementation's headless driver; run/drive joins RULE_SCOPES ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-cli:** --driver-repo on index and publish (default GITHUB_REPOSITORY); init writes .github/workflows/workflow-drive.yml, the repository_dispatch the harness's drive rule sends ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-headless:** --wait park, --run-id, --grace and the resume verb — a parked run exits 0 and a fresh driver picks it up; exit 5 when another tab or job holds the lease ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-lint:** index.json declares its driver repo (driver.repo) ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow:** driven runs — a headless run parks at a step that needs a person (wait=park, runId=, resume=1); the run/drive rule dispatches the implementation's driver; workflow.start and workflow.resume served over the MCP endpoint, submitStep re-dispatches, status answers pending ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))

## 1.0.0 (2026-09-05)


### Features

* **workflow-agent-tools:** the catalog — 11 workflow.* tools with closed schemas, annotations, the tool→scope map, MCP CallToolResult builders and RunSnapshot ([a62ddd0](https://github.com/bffless/apps/commit/a62ddd01f7fbadf82e8f802387f0d1727f69a112))
* **workflow-agent-tools:** the prose carries what a text-only host needs — waiting steps list their declared outputs and fields, describe names inputs ([a62ddd0](https://github.com/bffless/apps/commit/a62ddd01f7fbadf82e8f802387f0d1727f69a112))
* **workflow-agent-tools:** workflow.submitStep tells a model that values {} opens the step's island or form for the person in an agent host ([a62ddd0](https://github.com/bffless/apps/commit/a62ddd01f7fbadf82e8f802387f0d1727f69a112))
