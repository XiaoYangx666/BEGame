# @begame/core

The runtime core of BEGame, a TypeScript game framework for Minecraft Bedrock games and gameplay Addons.

GameEngine owns a game instance, GameState owns a phase, and GameComponent owns reusable behavior. State-scoped events and managed runners are released as the state ends. Participation policies coordinate player membership across games in one Script runtime.

## Install

```sh
npm install @begame/core
```

The behavior pack provides the peer dependencies: @minecraft/server >=2.10.0 and @minecraft/server-ui >=2.2.0. Bundle this package into your pack's script entry.

## Initialize

```ts
import { initBEGame } from "@begame/core";

initBEGame();
```

Initialization configures the framework; it does not start a game. Built-in commands and join callbacks are available separately from @begame/core/server. Tracing is optional and enabled by injecting a runtime from @begame/trace/minecraft.

## Documentation

- [Getting started](https://github.com/XiaoYangx666/SAPI-Game/blob/HEAD/docs/getting-started.md)
- [Architecture and ownership](https://github.com/XiaoYangx666/SAPI-Game/blob/HEAD/docs/architecture.md)
- [Guides and tutorials](https://github.com/XiaoYangx666/SAPI-Game/blob/HEAD/docs/README.md)

Keep installed BEGame packages on the same release version. MIT licensed.
