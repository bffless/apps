# Changelog

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
