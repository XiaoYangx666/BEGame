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

## Replay recording reliability

Custom `TraceScope.emit(schema, payload)` returns `boolean` in this version:

- `true` — accepted and encoded into the in-memory session buffer.
- `false` — disabled/ended session, or a validation/encoding error was isolated.

**An accepted event is not a durable storage acknowledgment.** Chunk sinks can still fail
when data is flushed. If the history store has fewer chunks/events than the Trace
footer declares, it marks that recording as interrupted and refuses a complete
`.begtrace` export instead of silently presenting partial data as complete.

The default Trace history budget is 2 MiB across completed sessions and can be
configured separately. The default chunk target is 20 KiB, not a guarantee that
one oversized custom event can be written to Minecraft Dynamic Properties:
large replay snapshots must be split into bounded event parts by the recording
layer. Preserve all parts and verify completeness before attempting Node replay.



[Trace guide](https://github.com/XiaoYangx666/BEGame/blob/HEAD/docs/game-trace.md) · [BDS integration](https://github.com/XiaoYangx666/BEGame/blob/HEAD/docs/server-net-export.md)

Keep installed BEGame packages on the same release version. MIT licensed.
