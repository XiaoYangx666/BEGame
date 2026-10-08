# Releasing BEGame

[Documentation](./README.md) · [Packaging](./packaging.md)

This guide is for repository maintainers. Building a behavior pack and publishing the framework's npm packages are separate operations.

## Release unit

The root workspace is private. Publish these five packages at one shared version:

1. @begame/trace-spec
2. @begame/core
3. @begame/trace
4. @begame/observatory
5. @begame/test

The publish script derives and sorts the dependency graph automatically. Installed sibling packages use exact versions, including the optional core peer in Trace. Update all five manifests, the root version, sibling references and the lockfile together. Install only the packages a consumer needs.

## Prepare the candidate

- Review the working tree, including changes already present before release preparation. Select the intended changes explicitly.
- Choose an unused stable version. Publish all five packages directly with the latest tag after validation; the planned initial version is 0.1.0, subject to registry availability.
- Check package ownership, repository links, MIT licenses and npm publishing access.
- Record the supported Minecraft build, Script API module versions and Node version used for validation.
- Write release notes describing public behavior, migration steps and evidence limits.

The current manifests declare 0.1.0. This guide does not establish whether that version is already published. Check the registry before choosing the final number.

## Local gates

From the repository root:

```sh
npm ci
npm run build
npm test
npm run test:treeshake
npm run release:check
npm run pack
```

The lockfile is not tracked in this repository at present. Until a reviewed lockfile is committed, use npm install instead of npm ci and record the resolved tool versions. Committing a lockfile is recommended before the final release candidate so CI and local builds resolve the same dependency graph.

The build checks TypeScript and builds all five packages, including Observatory. The publish script checks advertised entry points and publishes in dependency order. release:check and release:stable pass their flags directly to the publisher, avoiding shell argument-forwarding differences. Dry-run does not upload packages and does not prove account permissions or consumer runtime behavior.

npm run pack rebuilds and replaces the artifacts directory. Inspect each .tgz for README.md, LICENSE, JavaScript and declared type/export/bin targets. Observatory must also include its web assets and configuration template. Exclude local data, traces, experiments and credentials.

## Consumer and target-runtime gates

Use a clean consumer project, not workspace aliases:

- Install the candidate tarballs together; verify exact sibling versions resolve locally.
- Bundle a minimal behavior pack with core, then with the optional server and Trace entries.
- Exercise startup, a state transition, stop, disconnect/reconnect and empty-room cleanup in the supported Minecraft version.
- Install the Observatory tarball and check bgobs --help, UI loading, trace decode and export.
- Check a real client /connect session with matching command namespace. Verify BDS server-net separately if advertised for this release.

Node lifecycle tests do not establish rendering, actual chunk behavior, multiplayer client behavior or BDS transport acceptance. Mark each target-runtime result PASS, FAIL or NOT VERIFIED in the release notes.

## Publish

After the candidate has passed its gates and publication is authorized:

1. Commit the reviewed source, documentation and synchronized versions.
2. Publish the synchronized stable package set directly to latest:

```sh
npm run release:stable
```

3. Install from the registry in a clean consumer and repeat the installation/CLI smoke checks.
4. Create the matching Git tag and GitHub release with the compatibility matrix and migration notes.


npm publication is sequential, not atomic. If a package fails, record which packages succeeded and inspect registry state before retrying. Already published name/version pairs cannot be overwritten. Do not rerun the whole script blindly after a partial publication; publish only missing packages in dependency order, or prepare a new synchronized version.

## Release notes outline

- Version and dist-tag
- What BEGame provides: lifecycle ownership, reusable components, participation, testing and optional Trace
- Install commands and documentation entry point
- Migration from older SAPI-Game names/imports, if applicable
- Tested Minecraft / Script API / Node versions
- Local checks and target-runtime results
- Known limitations and deferred integrations

## Current candidate

See the [release notes draft](./release-notes.md) for the current package scope, local validation and remaining target-runtime gates. Publication targets latest directly.
