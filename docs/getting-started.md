# Getting started

[Documentation](./README.md) · [Architecture](./architecture.md) · [中文游戏教程](../tutorial/使用教程.md)

BEGame runs inside a Minecraft Bedrock behavior pack. You need a TypeScript project that bundles npm dependencies and declares Script API modules in its pack manifest.

## Install

```sh
npm install @begame/core
```

The core manifest requires these peer dependencies:

| Module | Declared requirement |
| --- | --- |
| @minecraft/server | >=2.10.0 |
| @minecraft/server-ui | >=2.2.0 |

Match your installed typings and behavior-pack manifest to the modules supported by your target Minecraft version. These ranges describe package requirements, not proof that every future Minecraft version is compatible.

[BEPack](https://github.com/XiaoYangx666/BEPack) is the repository's recommended build tool. Use its documentation for scaffolding, dependency resolution, deployment and pack export. Bundle BEGame into the behavior pack's script entry; npm installation alone does not install a playable addon.

## Initialize the runtime

In the behavior pack's script entry:

```ts
import { initBEGame } from "@begame/core";

initBEGame();
```

Call initialization once at the composition root to set your options. Defaults also apply without this call. Initialization configures the framework; it does not create or start a game.

For built-in commands and player join integration, use the separate server entry instead:

```ts
import { initBEGameServer } from "@begame/core/server";

initBEGameServer({
    onJoin(player) {
        // Your lobby or join behavior.
    },
    hub(player) {
        // Your return-to-hub behavior.
    },
});
```

The core entry does not register these server commands or start player polling.

## Create your first game

Follow the [game authoring tutorial](../tutorial/使用教程.md) in this order:

1. Define the context and player class, then create a game module.
2. Implement the module's Engine and initial State.
3. Add components and event subscriptions to the state that owns them.
4. Start the instance through Game.manager and give it a unique key.
5. Test transitions and shutdown with the [headless engine](./TEST_ENGINE.md), then verify the behavior in Minecraft.

The [worked example](../tutorial/实战/实战1.md) shows the same pattern in a complete minigame. Rendering, interactions and actual chunk behavior require in-game checks.

## Add diagnostics when needed

```sh
npm install @begame/trace
```

```ts
import { initBEGame } from "@begame/core";
import { createTraceRuntime } from "@begame/trace/minecraft";

initBEGame({ trace: createTraceRuntime(), traceStore: true });
```

Trace is explicitly injected. Follow the [Trace guide](./game-trace.md) to configure retention and export, and the [Observatory guide](../packages/observatory/README.md) to inspect sessions. Keep installed BEGame packages on the same version.
