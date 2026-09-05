# Changelog

## [1.6.0](https://github.com/bffless/apps/compare/workflow-lint-v1.5.1...workflow-lint-v1.6.0) (2026-09-05)


### Features

* **workflow-agent-tools:** workflow.start and workflow.resume describe what the MCP endpoint does — dispatch the implementation's headless driver; run/drive joins RULE_SCOPES ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-cli:** --driver-repo on index and publish (default GITHUB_REPOSITORY); init writes .github/workflows/workflow-drive.yml, the repository_dispatch the harness's drive rule sends ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-headless:** --wait park, --run-id, --grace and the resume verb — a parked run exits 0 and a fresh driver picks it up; exit 5 when another tab or job holds the lease ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow-lint:** index.json declares its driver repo (driver.repo) ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))
* **workflow:** driven runs — a headless run parks at a step that needs a person (wait=park, runId=, resume=1); the run/drive rule dispatches the implementation's driver; workflow.start and workflow.resume served over the MCP endpoint, submitStep re-dispatches, status answers pending ([#598](https://github.com/bffless/apps/issues/598)) ([cb71f93](https://github.com/bffless/apps/commit/cb71f93fda11c7e7d0dd60b6620bf45925c459b5))

## [1.5.1](https://github.com/bffless/apps/compare/workflow-lint-v1.5.0...workflow-lint-v1.5.1) (2026-09-02)


### Bug Fixes

* **workflow-lint:** validate --path-prefix against the publisher's /api/&lt;alias&gt; ([#567](https://github.com/bffless/apps/issues/567)) ([e8310f2](https://github.com/bffless/apps/commit/e8310f22255afd23b19072a1afb1454cdf6a1a42)), closes [#560](https://github.com/bffless/apps/issues/560)

## [1.5.0](https://github.com/bffless/apps/compare/workflow-lint-v1.4.0...workflow-lint-v1.5.0) (2026-09-01)


### Features

* **workflow-cli:** the @bffless/workflow CLI — identity engine, init, rename, add ([#556](https://github.com/bffless/apps/issues/556)) ([c9460d9](https://github.com/bffless/apps/commit/c9460d98440281e6145df4ac25da0b07e80f5ecb))

## [1.4.0](https://github.com/bffless/apps/compare/workflow-lint-v1.3.0...workflow-lint-v1.4.0) (2026-08-30)


### Features

* **workflow-lint:** warn when a job with needs has an if with no status function ([#478](https://github.com/bffless/apps/issues/478)) ([da22f63](https://github.com/bffless/apps/commit/da22f63ab7848ddc02a372d0b18d2ba236549853)), closes [#462](https://github.com/bffless/apps/issues/462)

## [1.3.0](https://github.com/bffless/apps/compare/workflow-lint-v1.2.0...workflow-lint-v1.3.0) (2026-08-30)


### Features

* **workflow-lint:** friendlier default value rendering — shape inference, `format: table|list|seconds|path`, pane-level Show raw ([#456](https://github.com/bffless/apps/issues/456)) ([0c4f37a](https://github.com/bffless/apps/commit/0c4f37a5e8f4a25fecb41b63dac3a5ff8fa7d4fc))

## [1.2.0](https://github.com/bffless/apps/compare/workflow-lint-v1.1.0...workflow-lint-v1.2.0) (2026-08-29)


### Features

* **workflow-lint:** images map on markdown outputs — mapped srcs render from /api/uploads on a finished run ([#446](https://github.com/bffless/apps/issues/446)) ([#447](https://github.com/bffless/apps/issues/447)) ([e673bf2](https://github.com/bffless/apps/commit/e673bf22f0cde600ae30bce327f78b0f4d3ee2d1))

## [1.1.0](https://github.com/bffless/apps/compare/workflow-lint-v1.0.1...workflow-lint-v1.1.0) (2026-08-29)


### Features

* **workflow-studio:** the Studio port ([#424](https://github.com/bffless/apps/issues/424)) ([2eee03a](https://github.com/bffless/apps/commit/2eee03a442b11e5d776bfaa803510941b8555a21))
* **workflow:** per-step `auto-accept` — Studio's "Auto-accept the cut edits" kickoff option replaces the run-page Accept button ([#439](https://github.com/bffless/apps/issues/439)) ([c8d171d](https://github.com/bffless/apps/commit/c8d171d896829a1d15a78be33d6ce0ab630bbc2d)), closes [#435](https://github.com/bffless/apps/issues/435)

## [1.0.1](https://github.com/bffless/apps/compare/workflow-lint-v1.0.0...workflow-lint-v1.0.1) (2026-08-27)


### Bug Fixes

* **workflow-lint:** run the CLI when invoked through a bin symlink ([#401](https://github.com/bffless/apps/issues/401)) ([677f0b7](https://github.com/bffless/apps/commit/677f0b7dbebe067c64c137cd0f62bc98aff6cfc7))

## 1.0.0 (2026-08-27)


### Features

* **workflow-lint:** publish the package, add the index verb and --path-prefix ([#396](https://github.com/bffless/apps/issues/396)) ([a900b9d](https://github.com/bffless/apps/commit/a900b9d506fb025b2e5deb099b205ae931ed571d))
* **workflow-lint:** workflow lint prototype for M0 ([#356](https://github.com/bffless/apps/issues/356)) ([806d5a6](https://github.com/bffless/apps/commit/806d5a67cb14a6c2f699f298099ee27fb49fba8b))
* **workflow:** harness scaffold, rule set and pure run engine ([#357](https://github.com/bffless/apps/issues/357)) ([7c74d24](https://github.com/bffless/apps/commit/7c74d24fe03d1e31355ef0d93b6acb57d11ca5ed))
* **workflow:** island host and the island step ([#368](https://github.com/bffless/apps/issues/368)) ([189f2a5](https://github.com/bffless/apps/commit/189f2a52dae3d639a5547c7a0e31baa99cac02f5))
* **workflow:** lint a relative pipeline path against the rule that serves it ([#394](https://github.com/bffless/apps/issues/394)) ([6e2bbc7](https://github.com/bffless/apps/commit/6e2bbc7e0125f9932b556ed372c3d9e8e407bdfc)), closes [#388](https://github.com/bffless/apps/issues/388)
* **workflow:** named renderers, form upgrades and run deletion ([#378](https://github.com/bffless/apps/issues/378)) ([a5221a0](https://github.com/bffless/apps/commit/a5221a0ba5e6b0a1c56ecb6c93fa2858e87d7196))
