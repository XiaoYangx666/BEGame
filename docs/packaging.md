# Packaging and tree-shaking

BEGame packages are consumed by bundling them into a single Minecraft script, so
whatever a game does not use should not reach its output. That is a property of
the built `dist/` plus the package manifests, not of the source, and it is
guarded by an executable check rather than by inspection.

## The contract

```shell
npm run test:treeshake
```

`scripts/treeshake-probe.mjs` bundles a handful of one-symbol consumers with
rolldown and inspects **which modules** were pulled in. It runs in CI after the
build.

It asserts both directions:

- `forbid` — modules that must be gone (unused components, the trace stack).
- `require` — modules that must survive. This is the more important half:
  `sideEffects` is a blunt instrument, and declaring it too broadly silently
  drops the worldLoad gating that several past fixes depend on.

Detection is by module id. Never scan the output text for identifiers: names
like `Timer` and `DisconnectTimeout` also occur as members of the trace event
vocabulary and produce false positives.

## `sideEffects`

The runtime library packages declare it. Observatory is a CLI application. `false` means "nothing here runs for its
own sake", which lets bundlers drop unused re-exports from barrels.

`@begame/core` cannot use `false`. Three modules do real work at import time:

| Module | Module-level effect |
| --- | --- |
| `dist/constants.js` | subscribes to `world.afterEvents.worldLoad` |
| `dist/system/worldReady.js` | subscribes to `world.afterEvents.worldLoad` |
| `dist/main.js` | builds the global manager / events singleton |

So it uses the array form, listing only those. `@begame/test` lists
`dist/register.js` (it installs Node module hooks). Everything else is `false`.

Two traps learned the hard way:

- The array is an **allowlist for the package's own build too**. A bare
  `import "./sideEffectfulModule"` inside a package that declares itself
  side-effect free gets dropped from that package's own `dist/`. Prefer a real
  value import, which cannot be eliminated.
- Subpath specifiers need their own `external` entry when building a sibling
  package. An exact-string `external: ["@begame/core"]` does not cover
  `@begame/core/trace`, and rolldown will then try to inline it and emit broken
  relative paths. Use regexes such as `^@begame/core(\/|$)`.

## Import-time vs call-time opt-in

A feature that is only enabled by a *call* cannot be tree-shaken away, because
the bundler cannot know the call will not happen. Features therefore have to be
separated by **reachability**, which means the implementation must live somewhere
the default entry cannot reach:

| Entry | Pulls in |
| --- | --- |
| `@begame/core` | the runtime, its global manager singleton, and `@begame/trace-spec` |
| `@begame/core/server` | server integration, `/game` commands, player tracking |
| `@begame/trace` | the trace runtime and codec, injected into core by the consumer |

## Trace is injected, not installed

`@begame/core` has no trace implementation and no dependency on one. Its hot
path only needs the vocabulary, which lives in the zero-dependency
`@begame/trace-spec`, plus the contract in `packages/core/src/trace/contract.ts`
(scope/session/runtime interfaces and inert stand-ins).

The consumer wires the implementation in at its own composition root:

```ts
import { initBEGame } from "@begame/core";
import { createTraceRuntime } from "@begame/trace";

initBEGame({ trace: createTraceRuntime(), traceStore: true });
```

`Game.attachTrace(runtime)` does the same outside `initBEGame`.

This replaced an earlier design where importing `@begame/core/trace` installed
the runtime through a module-level side effect into a registry. Injection is
better for reasons that are worth keeping in mind before "simplifying" it back:

- **The guarantee stops depending on the bundler.** An install-on-import design
  only works if every consumer's bundler honours `sideEffects`; the same
  mechanism already silently dropped a side-effect import during this repo's own
  `@begame/test` build. A `createTraceRuntime()` call is a value use and cannot
  be eliminated.
- **No hidden mutable module state**, so no "which module was evaluated first"
  hazard.
- `Game.trace` must still be a getter. `Game` is built while `main.ts` is
  evaluating, so a plain property would capture the inert runtime before
  anything could inject the real one.

## Where the platform boundary sits

`@begame/trace` is one package with two halves. Its root entry holds the codec
*and* the session/history logic, because none of that actually needs Minecraft:
the tick source is injected into `TraceManager`, and the storage substrate is
injected into `TraceHistoryStore` through the seams in
`packages/trace/src/runtime/storage.ts`. The `./minecraft` entry is the binding —
dynamic properties, `system.runInterval`, the worldLoad gate.

That split is why `@begame/core` and `@minecraft/server` are **optional peers**
of the package: without that, `npm i @begame/trace` in a Node-only consumer
would pull the game framework and, through its own peers, the Mojang packages —
for a decoder.

The boundary is enforced rather than merely intended. Because it is a convention
rather than a package-graph guarantee, `tests/trace-isolation.test.mjs` asserts
it mechanically on the built output:

- the platform bindings `dist/minecraft.js` and `dist/serverNet.js` may import Minecraft modules; platform-independent entries must remain isolated;
- `dist/index.js` must not re-export `./minecraft`, since that would silently
  give every codec consumer a Minecraft dependency;
- `packages/core/dist` must not reach `@begame/trace` at all.

It reads `dist` rather than source because that is what consumers actually load.

## Why not a dynamic `import()`

Deferring the load would also work, but it makes enabling tracing asynchronous,
which conflicts with the worldLoad ordering the runtime already depends on. The
opt-in entry keeps the composition synchronous and order-stable.

## Release

See the [release guide](./releasing.md) for synchronized versions, package validation, preview releases and publication order. The root workspace is private; the five package workspaces publish individually.
