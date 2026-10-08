# @begame/trace

BEGame Trace: binary codec, session management, history storage and platform bindings. Record lifecycle and business events, then inspect them with @begame/observatory.

## Install

```sh
npm install @begame/trace
```

## Entry points

| Entry | Purpose |
| --- | --- |
| @begame/trace | Platform-independent codec, sessions, history and log parsing |
| @begame/trace/minecraft | Script API storage, scheduling and runtime factory |
| @begame/trace/server-net | BDS transport binding |

Core and Minecraft modules are optional peers, so Node-only decoding does not require a Minecraft runtime. Supply the relevant peers when using platform bindings.

## Enable in a behavior pack

```ts
import { initBEGame } from "@begame/core";
import { createTraceRuntime } from "@begame/trace/minecraft";

initBEGame({ trace: createTraceRuntime(), traceStore: true });
```

Core has no Trace implementation dependency; inject it explicitly. History retention and export transports are configured separately.

[Trace guide](https://github.com/XiaoYangx666/SAPI-Game/blob/HEAD/docs/game-trace.md) · [BDS integration](https://github.com/XiaoYangx666/SAPI-Game/blob/HEAD/docs/server-net-export.md)

Keep installed BEGame packages on the same release version. MIT licensed.
