# BEGame Game Trace / Session Trace

## Scope

Game Trace is a structured, per-game execution history. It is not a console logger and it is not an event-sourcing API. One `GameEngine` instance owns one `TraceSession` from construction/start through stop/dispose. Core tracing is deliberately low-volume: lifecycle, participation, connection, timeout, runner/timer failures/cancellation, and developer business events.

High-frequency world activity (tick, position, block changes, effects, all Minecraft events) is not captured by default. A future diagnostic mode may add opt-in detail without changing the core format.

## Quick start: record and inspect

Install the game-side Trace package with your matching BEGame version:

~~~sh
npm install @begame/trace
~~~

Register the bridge in the behavior pack that owns the Trace runtime, before the startup event. Use the pack's existing custom-command namespace:

~~~ts
import { initBEGame } from "@begame/core";
import { createTraceRuntime, registerTraceConnectCommands } from "@begame/trace/minecraft";

const trace = createTraceRuntime();
registerTraceConnectCommands(trace, { namespace: "game" });
initBEGame({ trace, traceStore: { enabled: true, maxSessions: 500, maxBytes: 32 * 1024 * 1024 } });
~~~

Install and run the workbench on your computer:

~~~sh
npm install -g @begame/observatory
bgobs --connect --pack game
~~~

In the Bedrock client world, connect with operator permissions:

~~~text
/connect ws://127.0.0.1:18789
~~~

Open http://127.0.0.1:8787 to inspect sessions and export .begtrace files or a ZIP. The namespace passed to --pack must match registration. The default registration namespace is begame, but a pack already using another namespace must reuse its own.

The list and open running session refresh every three seconds. Exporting a running session saves a snapshot of that moment; game-side history is still subject to retention settings. The bridge uses commandResponse data and Base64 parts rather than chat output.

See the [Observatory guide](../packages/observatory/README.md) for configuration, local archives and CLI options. For dedicated servers use [server-net](./server-net-export.md). Repository developers can build once and use npm run observatory:connect -- --pack game.

## Runtime architecture

```text
Game / State / Component / Participation / Runner / Timer
                    |
                    v
               TraceScope
                    |
                    v
               TraceSession
        sequence + tick + ref tables
                    |
                    v
          BinaryTraceEncoder
                    |
                    v
          immutable TraceChunk
                    |
             session sink set
              /          \
             v            v
      TestTraceSink   TraceHistoryStore
       (@begame/test)   (TraceStorage seams)
                            |
                            v
                    ConsoleTraceExporter
                            |
                            v
                Minecraft Content Log / GUI
                            |
                            v
                  @begame/trace
```

`TraceSession` owns ordering and encoding. Gameplay code emits logical events through `TraceScope`. Sink membership is snapshotted when the session starts, so a runtime storage toggle cannot create a deliberately truncated stored session. Sink failures are isolated from game execution.

`@begame/trace-spec` is the shared, zero-dependency vocabulary: event ids, value and schema types, the management-side option shapes and the deferred error marker. `@begame/trace` is everything else, split by platform: its root entry holds the codec, chunk container, decoder, schema/session primitives, the console exporter, the log parser and the two runtime pieces (`TraceManager`, `TraceHistoryStore`), while the `./minecraft` entry holds the storage seams (world dynamic properties, the tick scheduler, the worldLoad gate) and the `createTraceRuntime` factory. `TraceHistoryStore` is a history store, not an export transport. `ConsoleTraceExporter` reads a completed history session and emits a copyable Base64 representation on demand.

### The storage seam

`TraceHistoryStore` never touches Minecraft. Chunking sessions, the retention policy (count / bytes / age), reload recovery and the "an accepted session must finish even after storage is disabled" invariant are all pure bookkeeping, so the substrate is injected through `TraceStorage` (`packages/trace/src/runtime/storage.ts`):

| Seam | Minecraft supplies | Tests supply |
| --- | --- | --- |
| `TraceKeyValueStore` | `world.*DynamicProperty*` | a `Map` |
| `TraceScheduler` | `system.runInterval` / `clearRun` | a recorded fake |
| `TraceWorldGate` | `worldReady` helpers | an always-ready stub |

The value type is deliberately `string \| number \| boolean \| undefined` to mirror dynamic properties, which is why chunk bytes are Base64 encoded before they reach the store.

Two consequences worth keeping:

- The root entry runs in plain Node, which is what lets the observatory server and offline tooling import it with no Minecraft runtime present. `tests/trace-isolation.test.mjs` fails CI if any module other than `dist/minecraft.js` imports `@minecraft/*` or `@begame/core`.
- The store's behaviour is unit-testable without the virtual world. `tests/trace-history-store.test.mjs` drives it through its `TraceSink` contract with fake seams.

### Enabling tracing

`@begame/core` never imports the trace runtime or the codec. It only knows
`@begame/trace-spec` and the contract in `packages/core/src/trace/contract.ts`,
so tracing is wired in by the consumer rather than switched on by an option:

```ts
import { initBEGame } from "@begame/core";
import { createTraceRuntime } from "@begame/trace/minecraft";

initBEGame({ trace: createTraceRuntime(), traceStore: true });
```

Outside `initBEGame`, `Game.attachTrace(runtime)` does the same. A game that
never imports the Minecraft entry ships no trace code at all; `npm run
test:treeshake` asserts that in CI, and `docs/packaging.md` explains why
injection is used instead of an install-on-import entry.

Consequences worth knowing:

- Trace symbols are not exported from `@begame/core`. Import the codec from
  `@begame/trace`, and the runtime factory from
  `@begame/trace`.
- `initBEGame({ traceStore: true })` without an injected runtime is inert and
  logs an error, rather than silently recording nothing.
- Injection order relative to `@begame/core` does not matter, because
  `Game.trace` resolves on access rather than at module evaluation.
- Errors cross the runtime boundary as a deferred marker rather than a
  serialized value, so `traceError` — which walks `cause` chains under UTF-8
  byte budgets — only runs when a session is actually listening.

## Session model

A session header contains:

- `sessionId`, `formatVersion`
- `gameType`, `gameKey`, `gameInstanceId`
- optional BEGame / pack version
- start tick and wall time
- a bounded structural snapshot of the initial config

A session footer contains:

- status: `completed | aborted | crashed | interrupted | reloaded`
- end tick and wall time
- end reason
- event and chunk counts

Every event has a strictly increasing `sequence`, a tick, a type, a source, and a structured payload. Sequence is the canonical within-session order; wall-clock time is not used to order same-tick events.

## Built-in event families

Core reserves type ids below 128. Current families are:

| Family | Events |
| --- | --- |
| Game | `game.created`, `game.starting`, `game.started`, `game.start_failed`, `game.stopping`, `game.stopped`, `game.disposed` |
| State | `state.push`, `state.enter`, `state.exit`, `state.remove`, `state.transition`, `state.root_changed`, `state.enter_failed` |
| Component | `component.attach_started`, `component.attached`, `component.detached`, `component.attach_failed`, `component.error` |
| Event callback | `event.callback_error` |
| Participation | `participation.acquire`, `participation.joined`, `participation.released`, `participation.acquire_rejected` |
| Connection | `player.connect`, `player.disconnect`, `player.reconnect` |
| Offline guard | `disconnect_timeout.started`, `disconnect_timeout.cancelled`, `disconnect_timeout.expired` |
| Runner | `runner.uncaught_error`, `runner.cancelled` |
| Timer | `timer.started`, `timer.expired`, `timer.cancelled` |
| Diagnostic | `debug.message` |

A connection event never implies participation release. `DisconnectTimeoutComponent` emits timeout lifecycle independently and, when configured to release, `GamePlayerManager.leave()` emits a separate `participation.released` with reason `disconnect-timeout`.

`state.subscribe` / `component.subscribe` callbacks are a synchronous contract. Async work belongs in `runner.run(...)`, where failures become `runner.uncaught_error`. A callback that returns a thenable triggers a one-time `debugMode` warning; its Promise rejection is not captured by the Trace Session. An `event.callback_error` marks that an issue happened and turns the event red in the Observatory, but it never by itself flips the session status to `crashed`; only a failed game lifecycle does that.

## Automatic emit points

| Owner | Emit point |
| --- | --- |
| `GameManager.startGame` | session begin, created, starting, started, start failure |
| `GameManager.stopGameByKey` | stopping, stopped, disposed, session final status/reason |
| `GameManager.disposeAll` | silent stopping/dispose and `reloaded`/`interrupted` classification |
| `GameEngine` | state push/enter/failure/exit/remove/transition/root changes |
| `GameState` | component attach start/success/failure, detach/error |
| `GamePlayerManager` | participation acquire/join/reject/release and player ref registration |
| `EventManager` | `event.callback_error` when a State/Component subscription callback throws (payload carries the signal name); emitted before the error is rethrown to the underlying signal |
| connection signal bridge | connect/disconnect/reconnect for players already known to a session |
| `DisconnectTimeoutComponent` | timeout start/cancel/expire |
| `RunnerManager` | uncaught async runner error and explicit/lifecycle cancellation |
| `Timer` | start/expire/cancel only; never timer ticks |

The connection bridge is active only while at least one Trace Session exists. This remains true if World DP storage is disabled during an already-running stored session.

## Typed developer events

Developer business events use an event name plus an explicit field schema:

```ts
import { defineTraceEvent, optionalTraceField } from "@begame/core";

const eliminated = defineTraceEvent("pof.player.eliminated", {
    victim: "player",
    killer: optionalTraceField("player"),
    aliveCount: "uint",
    reason: "string",
});

this.trace.emit(eliminated, {
    victim: victim.id,
    killer: killer?.id,
    aliveCount: 2,
    reason: "entityDie",
});
```

Supported first-phase scalar field types are `boolean`, `uint`, `int`, `number`, `string`, and `player`. Optional fields are encoded with a bitset. Schema name collisions with a different shape are rejected inside Trace Core and reported as an internal trace error rather than breaking game execution.

`trace.debug(message, fields)` remains available for occasional diagnostics, but business semantics should use typed events.

## Binary format

`.begtrace` and `TraceChunk` are binary, not JSON.

The session maintains dictionaries/ref tables for strings, players, state instances, component instances and custom event schemas. Custom event ids start at 128. State/component refs are instance refs rather than only class names, so repeated instances of one state/component type remain distinguishable.

Integers use unsigned varint; signed integers use zigzag + varint; floating-point fields use little-endian float64. Event ticks are stored as deltas inside a chunk. Event sequence numbers are implicit from `firstSequence + eventIndex`.

A chunk is immutable after sealing. The default binary target is 20 KiB. A chunk may also rotate when the tick span exceeds the configured threshold. The encoder does not schedule per-tick work solely for tracing.

Error payloads are byte-budgeted because sessions are stored in World Dynamic Properties: `traceError` caps each message (512 B top-level, 256 B nested) and stack (4 KiB top-level, 256 B nested), shares one 8 KiB UTF-8 text budget per error value, limits a serialized error tree to 16 entries and 6 levels, and reports excess `AggregateError.errors` as an `omitted` count. Child errors are serialized before wrapper stacks, so leaf/root-cause stacks win the shared budget. Truncated nodes carry `truncated: true`. `traceError` is also total: hostile thrown values (throwing getters, proxies, throwing `toString`) can never make it throw and replace the original exception at a catch boundary.

The decoder reconstructs session-wide dictionaries in chunk order and exposes logical events. JSON/JSONL is a derived representation only.

## Sink contract

```ts
interface TraceSink {
    onSessionStart?(header: TraceSessionHeader): void | Promise<void>;
    onChunk(chunk: TraceChunk): void | Promise<void>;
    onSessionEnd?(end: TraceSessionEnd): void | Promise<void>;
}
```

Core never awaits a Sink on the gameplay path. Promise rejection and synchronous Sink errors are caught and reported through trace-internal diagnostics only. `TraceManager.setSink()` remains available primarily for test/custom consumers; production world history is exposed separately as `Game.trace.store`.

## Test / file sink

`BEGameTestEngine` installs an in-memory `TestTraceSink` as `env.gameTrace`. The existing `env.trace` remains the harness action trace and is intentionally separate.

`TestTraceSink` can return raw `.begtrace` bytes or decode them for assertions. `FileTraceSink` is Node-only and writes completed `.begtrace` sessions for CI artifacts.

## TraceHistoryStore

`TraceHistoryStore` persists history through the injected `TraceStorage` seams. `@begame/trace` backs them with Minecraft World Dynamic Properties; it does not depend on SAPI-Pro `DPDataBase`. See [The storage seam](#the-storage-seam) for the split.

Storage is **disabled by default**. Developers can opt in during initialization:

```ts
import { initBEGame } from "@begame/core";
import { createTraceRuntime } from "@begame/trace";

initBEGame({
    trace: createTraceRuntime(),
    traceStore: {
        enabled: true,
        maxSessions: 50,
        maxBytes: 2 * 1024 * 1024,
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        cleanupIntervalTicks: 6000,
    },
});
```

A boolean is also accepted:

```ts
initBEGame({ trace: createTraceRuntime(), traceStore: true });
initBEGame({ trace: createTraceRuntime(), traceStore: false });
```

Runtime control is available without reinitializing BEGame:

```ts
Game.trace.store.enable();
Game.trace.store.disable();
Game.trace.store.configure({ maxSessions: 20 });

console.log(Game.trace.store.enabled);
const sessions = Game.trace.store.list();
const latest = Game.trace.store.latest();
```

Runtime toggle semantics are intentionally session-safe:

- disabling stops **new** sessions from being persisted;
- a session accepted before disable continues through its final chunk/footer;
- enabling does not attach storage halfway through a game that already started;
- disabling never deletes existing history.

Reserved DP namespace:

```text
begame.trace.v1.<session>.meta
begame.trace.v1.<session>.0
begame.trace.v1.<session>.1
begame.trace.v1.<session>.2
...
```

Sealed chunk values are Base64. Session metadata records the header, current/final status, committed chunk/event counts and final footer. A stale `running` record discovered when the store is enabled is finalized as `interrupted` with reason `runtime-recovered`, preserving all chunks that had already been sealed.

Retention works at whole-session granularity. Cleanup runs periodically while storage is enabled and after a session completes. Current limits are age, completed-session count and approximate stored Base64 payload bytes. Active sessions are never collected.

Default retention values are 50 sessions, approximately 2 MiB of Base64 chunk payloads, seven days, and a 6000-tick cleanup cadence.

## Console export

Console export is an on-demand transport over stored history:

```ts
// latest completed stored session
Game.trace.exportToConsole();

// explicit historical session
Game.trace.exportToConsole(sessionId);
```

The exporter reconstructs the complete `.begtrace`, Base64-encodes it, and writes warning-level records. The default maximum payload is 24,000 Base64 characters per warning, so ordinary sessions usually fit in one record while larger sessions are automatically split.

Machine marker:

```text
[BEGAME_TRACE:v1:<sessionId>:<part>/<partCount>]<base64>
```

Minecraft Content Log normally wraps that as, for example:

```text
[Scripting][warning]-[BEGAME_TRACE:v1:abc123:1/1]QkVHVAE...
```

The marker deliberately does not depend on Minecraft's surrounding log prefix, because Content Log can contain Localization, Sound and unrelated Scripting messages around it.

## @begame/trace

`@begame/trace` is the whole Trace package. Its root entry is platform-independent and shared by the runtime and tooling:

- vocabulary and constants: session header/end/chunk types, built-in event ids, source kinds (re-exported from `@begame/trace-spec`);
- codec: varint/zigzag, UTF-8, `BinaryReader`/`BinaryWriter`, `.begtrace` container, chunk encoder/decoder;
- session primitives: `TraceScope`, `TraceSession`, `defineTraceEvent`, `ConsoleTraceExporter`;
- the runtime: `TraceManager`, `TraceHistoryStore` and the `TraceStorage` seams;
- the offline Content Log parser (see below).

Its only dependency is `@begame/trace-spec`. `@begame/core` and `@minecraft/server` are **optional peers**, used solely by the `./minecraft` subpath, which is the Minecraft binding: storage seams plus `createTraceRuntime`. Nothing else in the package may reach for either, and `tests/trace-isolation.test.mjs` enforces that on the built output.

Consumers that install BEGame packages from a local checkout (`"@begame/core": "file:../begame/packages/core"`) must also declare the trace packages they use, with the same version (`@begame/trace-spec` and `@begame/trace` as `file:` paths or the packed tarballs). Like all npm `file:` dependencies, the packages are copied into `node_modules`, so re-run `npm install` after rebuilding BEGame.

## Content Log parsing

The parser extracts Console Trace exports from raw Minecraft Content Log text. It lives in the platform-independent root entry, so plain Node.js can import it without a Minecraft runtime.

```ts
import {
    collectTraceExports,
    decodeTraceLog,
    extractBegTraceBytes,
} from "@begame/trace";

const sessions = collectTraceExports(contentLogText);
const bytes = extractBegTraceBytes(contentLogText); // latest complete export
const trace = decodeTraceLog(contentLogText);
```

The parser:

- ignores unrelated log lines;
- finds the `BEGAME_TRACE` marker anywhere in the text;
- rejoins multipart exports in order;
- tolerates repeated identical parts;
- rejects conflicting duplicate parts/part counts;
- reports exactly which parts are missing from an incomplete export;
- can select a specific `sessionId` or default to the latest complete export;
- can return raw `.begtrace` bytes or a fully decoded logical session.

Future Observatory views, summary, timeline, comparison and Agent-facing analysis helpers belong in this package rather than in the Minecraft runtime package.

## BEGame Observatory

`packages/observatory` is the BEGame trace analysis workspace and its built-in HTTP service. Build once, then start with the transport you need:

```shell
npm run build                  # 构建前端 bundle 与服务端（与启动分离）
npm run observatory            # 只有 UI + 解码 API
npm run observatory:connect    # 额外开启 /connect 桥
npm run observatory:net        # 额外开启 BDS server-net 桥
```

Then open `http://127.0.0.1:8787` (override with `--port <n>` or `PORT=xxxx`). The UI is a React app (React 19, bundled by rolldown into `packages/observatory/public/build/app.js`, with React inlined, so it is a build-time dependency only). The API is a Hono app (`packages/observatory/server/`, TypeScript) bundled by rolldown into `packages/observatory/dist/server.js`; `hono`, `@hono/node-server` and `@begame/trace` deliberately stay external and resolve from the package's declared dependencies.

### 按需端口

默认只监听 HTTP。`/connect` 桥与 BDS `server-net` 桥对应两种互斥的游戏接入方式，必须显式开启，且不能同时开启；HTTP 上传 sink 默认关闭。完整选项见 `--help`。

| 开关 | 端口 | 用途 |
| --- | --- | --- |
| （默认） | 8787 | HTTP + 工作台 UI + 解码 API |
| `--connect` | 18789 | 客户端 `/connect` 桥 |
| `--net` | 18790 | BDS trace net |
| `--ingest` | 复用 HTTP 端口 | `POST /api/ingest` 上传 sink |

`--connect` 与 `--net` 同时给出会直接报错退出；`--no-http` 可以只跑桥不跑工作台。

两种游戏桥都是**实时查询代理**，会话本体在游戏侧；游戏断连后工作台就看不到它们。Observatory 默认开启**本地归档**（`--no-archive` 关闭，`--archive-dir` / `BEGAME_ARCHIVE_DIR` 换目录）：它每 3 秒把已完成的会话拉取到 `data/archive/`，断连后仍作为「未连接 · 已归档」的数据源列出并可从磁盘读取/导出。

### 视图（通用）

工作台不针对任何具体游戏：它只认识 BEGame 自己的内置事件族，以及「自定义事件把具体类型放在 `payload.type`」这一通用约定。因此同一套视图适用于任何基于 BEGame 的包。

- **概览**：事件族分布（点击即筛选事件流）、会话信息、诊断信号、参与者/组件摘要。
- **事件流**：按归属状态分段的统一时间线；按事件族筛选；默认折叠框架内部事件（状态/组件挂载、被取消的运行时任务等）；文本搜索。
- **结构**：状态树与组件生命周期。
- **参与者**：玩家、座位变更、参与/连接时间线。
- **原始**：可筛选的事件表，以及可复制的「分析 JSON / 会话 JSON」。

- paste a Content Log, or drop a `.log` / `.txt` / raw `.begtrace` file; multiple exports in the same log can be switched with missing parts reported;
- 会话可以来自本地导入，也可以来自已开启的数据源（`/connect`、BDS net、HTTP ingest）。

### Agent 接口

面向 agent 的结构化接口，与分析模型同源：

```text
GET  /api/health                       → { ok, name, version, capabilities }
GET  /api/sources                      → 已配置的数据源
GET  /api/sessions                     → 汇总所有数据源及其会话
GET  /api/session/:id?source=&pack=    → 某会话的原始 .begtrace 字节
                                         加 &format=json 则返回解码后的完整会话
POST /api/analyze                      → body = 日志文本或 .begtrace，返回结构化分析
GET  /api/analyze?source=&pack=&id=    → 直接分析已连接 / 已存会话
POST /api/decode                       → 解码结果 + 顶层 analysis
```

`analysis` 完全通用：`families` / `severities` / `typeCounts` / `sourceCounts`、`players` / `seats`、`stateTree`、`components`、`diagnostics`、`domainTypes` / `domainEvents`。它不含任何游戏专有字段，自定义事件只按 `payload.type` 归类。`source` 取值为 `connect` / `net` / `ingest`；`net` 需要额外的 `pack` 参数。

基础 API 仍然保留：

```text
GET  /api/health            → { ok, name, version, capabilities }
POST /api/decode            → decoded session JSON; body is log text or raw .begtrace bytes
POST /api/decode?session=ID → select a specific export
```

The Observatory imports only the platform-independent root of `@begame/trace`, so the same decode endpoint serves offline imports and live sources.

## Deferred adapters / tools

Implemented elsewhere:

- `/connect` live inspection is described in [the section above](#connect-live-inspection).
- `@minecraft/server-net` HTTP/WebSocket upload for Bedrock Dedicated Server is
  documented in [BDS server-net 导出](./server-net-export.md).

Still deferred:

- diagnostic high-frequency mode
- richer Agent query API (the current `/api/analyze` is a structured summary, not a query language)
- pin/bug-report retention policy

They can build on the existing `.begtrace`, Store, analysis model and decoder contracts without changing gameplay lifecycle tracing.
