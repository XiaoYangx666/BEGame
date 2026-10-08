# Release notes draft — BEGame 0.1.0

This is a candidate announcement, not a published-release record. The planned initial stable version is 0.1.0, published directly with the latest tag after registry and target-runtime checks.

BEGame is a TypeScript game framework for Minecraft Bedrock games and gameplay Addons. Games own instances, states own phases, and components own reusable behavior. State-scoped events and managed runners are cleaned up when their phase ends.

## Included

- Game instances, state trees, reusable components and coordinated player participation.
- Disconnect grace periods and empty-room cleanup as composable components.
- Headless lifecycle tests running the actual framework in Node.
- Optional Trace recording and Observatory inspection/export.
- Separate server integration and platform-specific Trace bindings.
- An English project overview with a Chinese counterpart, a focused documentation index and setup/architecture guides.

## Install

```sh
npm install @begame/core
```

Install optional packages as needed and keep installed BEGame packages on the same release version. Core declares @minecraft/server >=2.10.0 and @minecraft/server-ui >=2.2.0 peers; the behavior pack must supply supported modules in its manifest.

[Getting started](./getting-started.md) · [All documentation](./README.md)

## Migration

Use @begame/core and its documented subpaths for current examples. Built-in server initialization is provided by @begame/core/server. Trace must be constructed and injected explicitly. Replace old AutoStopState-based room examples with AutoStopComponent and, when needed, DisconnectTimeoutComponent on a persistent root state.

Persist explicit game snapshots rather than serializing runtime states. Match the Trace command namespace to the namespace configured in Observatory.

## Validation

- TypeScript check and all package builds: PASS.
- Unit/headless suite: 205 tests across 31 files, PASS.
- Tree-shaking probes: 6/6 PASS.
- Fixed-argument npm publishing dry-run: all five packages PASS; no upload.
- Five local tarballs: required files and Observatory web assets present.
- Clean consumer install from all five tarballs: PASS with install scripts and peer auto-install disabled.
- Installed Observatory CLI help and Node-only Trace/spec imports: PASS.
- README language switching, logo asset and local documentation links checked.

Local toolchain: Node 26.9.0, npm 12.0.2, Vitest 5.0.1. The repository CI is configured for Node 24; that CI run was not executed during this preparation.

## Before announcement

- Verify all npm package names, ownership and the selected version before publication.
- Commit a reviewed dependency lockfile and rerun the candidate gates with it.
- Fill in the supported Minecraft build and actual in-game results: startup, transitions, shutdown, reconnect and cleanup.
- Validate client /connect and BDS server-net separately. Neither transport was exercised against a live game during this preparation.
- Complete clean-consumer behavior-pack bundling and peer-dependency checks on the chosen Minecraft toolchain.

See the [release guide](./releasing.md) for publication order, direct latest publication and partial-failure handling. Detailed gameplay tutorials remain primarily in Chinese.
