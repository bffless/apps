# Changelog

## [1.2.0](https://github.com/bffless/apps/compare/workflow-cli-v1.1.1...workflow-cli-v1.2.0) (2026-09-05)


### Features

* **workflow-agent-tools:** workflow.start and workflow.resume describe what the MCP endpoint does — dispatch the implementation's headless driver; run/drive joins RULE_SCOPES ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-cli:** --driver-repo on index and publish (default GITHUB_REPOSITORY); init writes .github/workflows/workflow-drive.yml, the repository_dispatch the harness's drive rule sends ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-headless:** --wait park, --run-id, --grace and the resume verb — a parked run exits 0 and a fresh driver picks it up; exit 5 when another tab or job holds the lease ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-lint:** index.json declares its driver repo (driver.repo) ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow:** driven runs — a headless run parks at a step that needs a person (wait=park, runId=, resume=1); the run/drive rule dispatches the implementation's driver; workflow.start and workflow.resume served over the MCP endpoint, submitStep re-dispatches, status answers pending ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))

## [1.1.1](https://github.com/bffless/apps/compare/workflow-cli-v1.1.0...workflow-cli-v1.1.1) (2026-09-05)


### Bug Fixes

* **workflow-cli:** the /w/&lt;alias&gt;/* forwarder lists the caller's credential (cookie, authorization) in its headerConfig — the CE backend strips it from an in-process sibling call otherwise, so an app token never reached the alias ([3e3778c](https://github.com/bffless/apps/commit/3e3778c331b5db5f8fccbf5331a3e74c1ff822e0))

## [1.1.0](https://github.com/bffless/apps/compare/workflow-cli-v1.0.0...workflow-cli-v1.1.0) (2026-09-02)


### Features

* **workflow-cli:** publish --name/--description flow into the index ([#569](https://github.com/bffless/apps/issues/569)) ([a28102a](https://github.com/bffless/apps/commit/a28102a205f79dad844f1f2ce782f987ee035793))


### Bug Fixes

* **workflow-cli:** refuse --skip-existing on load-bearing collisions; report directory merges ([#566](https://github.com/bffless/apps/issues/566)) ([e61e334](https://github.com/bffless/apps/commit/e61e3344ca9deab25979c818fce47533d0640a85)), closes [#559](https://github.com/bffless/apps/issues/559)

## 1.0.0 (2026-09-01)


### Features

* **workflow-cli:** publish drives index → rules push → upload → attach ([#558](https://github.com/bffless/apps/issues/558)) ([7015ce2](https://github.com/bffless/apps/commit/7015ce2f27204c04b7aaea8f0ea111080bfe04a5))
* **workflow-cli:** the @bffless/workflow CLI — identity engine, init, rename, add ([#556](https://github.com/bffless/apps/issues/556)) ([c9460d9](https://github.com/bffless/apps/commit/c9460d98440281e6145df4ac25da0b07e80f5ecb))
