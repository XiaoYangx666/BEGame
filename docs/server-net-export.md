# BDS server-net 导出与远程管理

本文说明 BEGame 在 **Bedrock Dedicated Server (BDS)** 上的 Trace 导出链路：
一个行为包如何把历史对局交给本机 Observatory，以及 Observatory 如何反过来
查询、下载和管理这些对局。

客户端自建房间 / LAN 世界不适用本文，请继续使用 `/connect` 桥（见
[game-trace.md](./game-trace.md)）。

## 为什么不复用 `/connect`

`/connect` / `/wsserver` 是**客户端命令**。BDS 没有这个命令；`server.properties`
里的 `connect` 只是脚本调试器（`allow-outbound-script-debugging`）的，协议也
不同。因此服务端必须走 `@minecraft/server-net`。

`@minecraft/server-net` **只在 BDS 可用**（客户端与 Realms 都不支持），且目前是
beta 模块：需要 Beta APIs，并在行为包 manifest 中声明。

## 架构

```text
BDS 行为包 (script runtime)
  TraceManager ──chunks──▶ createServerNetTraceBridge
        ▲                         │  websocket.connect (server-net WS client)
        │  request/response       ▼
        └────────────────── Observatory TraceNetBridge  ws://<host>:18790/
                                  │
                                  ├── GET  /api/net/*        （HTTP，给 UI / 脚本）
                                  └── 工作台 UI 的 “BDS” 数据源
```

方向与 `/connect` 相同（都是游戏侧发起、Observatory 监听），区别是协议是
BEGame 自己的，而不是 `/connect` 的 `commandRequest/commandResponse`。

## 游戏侧

### 双向桥（推荐）

```ts
import { runAfterWorldLoad } from "@begame/core/world-ready";
import { createTraceRuntime } from "@begame/trace/minecraft";
import { createServerNetTraceBridge } from "@begame/trace/server-net";

const trace = createTraceRuntime();
const bridge = createServerNetTraceBridge({
    url: "ws://127.0.0.1:18790/",
    token: undefined,          // 与 Observatory 的 BEGAME_NET_TOKEN 对应
    trace,                     // 需要 store + snapshotBytes 的运行时
    packId: "partygames",      // 稳定标识，Observatory 用它路由请求
    packName: "小游戏行为包",   // 仅展示
});

runAfterWorldLoad(() => {
    trace.store.restoreEnabled();  // 恢复上次的开关状态，默认关闭
    bridge.start();
});

// 其余初始化（initBEGame / initBEGameServer）照常
```

`restoreEnabled()` 读取持久化在动态属性里的开关（键 `begame.trace.v1.enabled`），
**没有记录过时默认关闭**。`enable()` / `disable()` 会把这个状态写回去，所以
Observatory 的 `Store` 按钮和游戏内命令切换后能跨重启保留；启动时不要再无条件
`trace.store.enable()`，否则每次重启都会把用户关掉的 trace 又打开。

`createServerNetTraceBridge` 暴露 `start()` / `stop()` / `connected` / `suspended`。
断线后自动重连，退避为 `reconnectTicks`（默认 100 tick = 5 秒）起、每次失败翻倍，
封顶 `maxReconnectTicks`（默认 1200 tick = 60 秒）。首次失败只报一次，避免刷屏。

连续失败达到 `maxConsecutiveFailures`（默认 8 次）后桥会暂停（`suspended` 为
`true`）并不再发起连接，直到再次调用 `start()`。

> 为什么要有上限：BDS 的 `@minecraft/server-net`（beta）WebSocket 在被反复
> 失败的 `websocket.connect` 打时会把整个 BDS 进程 `abort` 掉（日志表现为
> `libc++abi: terminating`，且没有任何 JS 异常）。所以 Observatory 长期不在线
> 时，桥宁可不连，也不要无限重连。需要长期常驻的话，请让 Observatory 一直
> 监听 net 端口（见下文），而不是把上限调大。

桥在游戏侧执行这些操作（`TraceNetRequest`）：

| op | 说明 |
| --- | --- |
| `list` | `trace.store.list()` |
| `begin` / `part` | 把某一局编码成 `.begtrace` 并按 `TRACE_NET_PART_CHARS` 分片返回 |
| `delete` | 删除指定会话 |
| `clear` | 删除全部非运行中的会话 |
| `store` | 开 / 关 Trace Store |
| `status` | store 状态与数量 |

### HTTP 单向 sink（备选）

只需要在一局结束后把容器推给 Observatory、不需要远程管理时：

```ts
import { createServerNetTraceSink } from "@begame/trace/server-net";
trace.setSink(createServerNetTraceSink({ url: "http://127.0.0.1:8787/api/ingest" }));
```

它会在 session 结束时 `encodeBegTrace` 并用 `POST /api/ingest` 分片上传；同样
有有界队列，失败只回调 `onError`，不影响游戏。

## Observatory 侧

Observatory **默认只监听 HTTP 工作台**，其余端口必须显式开启：

```shell
npm run build                  # 构建前端 bundle 与服务端
npm run observatory            # 只有 HTTP（UI + 解码 API）
npm run observatory:net        # 额外开启 BDS trace net
npm run observatory:connect    # 额外开启 /connect 桥（与 --net 互斥）
```

也可以直接调用 `node packages/observatory/dist/server.js --help` 查看全部选项：

| 开关 | 端口 | 用途 |
| --- | --- | --- |
| （默认） | `8787` | HTTP + 工作台 UI + 解码 / ingest API |
| `--connect` | `18789` | `/connect` 桥（客户端世界） |
| `--net` | `18790` | BDS trace net |
| `--ingest` | 复用 HTTP 端口 | `POST /api/ingest` 上传 sink |

`--connect` 与 `--net` 不能同时开启；同时给出会报错退出。`--no-http` 可以只跑桥。

### 本地归档（断连后仍在）

net / connect 桥只是实时代理，会话存在游戏侧；游戏一断连，工作台就列不出它们。
Observatory 默认会把这两个桥的**已完成会话**镜像到本地
（`data/archive/<kind>/<pack>/<sessionId>.begtrace`），断连后仍以「未连接」数据源列出、
标注「已归档」，可查看与导出。行为要点：

- 只归档 `status !== "running"` 的会话，进行中的继续走实时桥；
- 每 3 秒轮询、每次最多 5 局，避免拖慢 `/connect` 的单条命令队列；
- `DELETE /api/net/session/:id` 与 `POST /api/net/clear` 会连同归档一起删除；
- `GET /api/session/:id`、`/api/net/session/:id` 以及两个导出接口都优先读归档，
  因此桥离线时也能导出；
- `--no-archive` 关闭；`--archive-dir` / `BEGAME_ARCHIVE_DIR` 指定目录。

对应的环境变量只提供取值，不会自行开启监听：

- `BEGAME_NET_PORT`：trace net 端口，默认 `18790`。
- `BEGAME_CONNECT_PORT`：`/connect` 端口，默认 `18789`。
- `BEGAME_NET_TOKEN`：trace net 握手 token；回退 `BEGAME_INGEST_TOKEN`；留空不校验。
- `BEGAME_INGEST_TOKEN` / `BEGAME_INGEST_DIR`：HTTP ingest 的 token 与落盘目录
  （默认 `packages/observatory/data`）。
- `BEGAME_ARCHIVE_DIR`：本地归档目录（默认 `packages/observatory/data/archive`）。
- `PORT` / `HOST`：HTTP 服务地址，默认 `127.0.0.1:8787`。

工作台 UI 会根据实际启用的能力显示数据源；未开启的桥不会出现，也不会占用端口。

### HTTP API

net 相关：

```text
GET    /api/net/status                 → { enabled, connected, sources: [{ source, packName?, store }] }
GET    /api/net/sessions               → { sources: [{ source, packName?, store, sessions, error? }] }
GET    /api/net/session/:id?source=ID  → .begtrace 字节
DELETE /api/net/session/:id?source=ID  → { deleted }
POST   /api/net/clear                  { source }            → { removed }
POST   /api/net/store                  { source, enabled }   → { store }
POST   /api/net/export                 { items: [{ source, id }] } → ZIP
```

通用 / agent 接口（跨数据源）：

```text
GET    /api/health                     → { ok, name, version, capabilities }
GET    /api/sources                    → 已配置的数据源
GET    /api/sessions                   → 汇总所有数据源及其会话
GET    /api/session/:id?source=&pack=  → 原始 .begtrace 字节（&format=json 返回解码会话）
POST   /api/analyze                    → body = 日志或 .begtrace，返回结构化分析
GET    /api/analyze?source=&pack=&id=  → 直接分析已连接 / 已存会话
```

一个 Observatory 可同时接受多个包（默认上限 8 个），按各自握手里的 `packId`
区分；同名包重连会替换掉旧的 socket。旧版本包没有 `packId` 时回退用
`packName`。

`/api/ingest/*` 是 HTTP sink 的入口，与 trace net 并存，可只用一个（且需要
`--ingest` 才会启用）。

## 行为包集成：双构建

因为 `@minecraft/server-net` 只存在于 BDS，**不能写进普通包的 manifest**（否则
非服务器环境加载脚本会失败）。做法是同一份源码编译两次：

```text
src/bootstrap.ts       # 共享组合根
src/main.ts            # 普通版：/connect 桥
src/main.server.ts     # BDS 版：server-net bridge
```

两份 bepack 配置，只有入口和依赖不同：

```ts
// bepack.config.ts（普通版）
packs: { bp: {
  compile: { entry: "src/main.ts" },
  dependencies: { "@minecraft/server": "stable", /* 无 server-net */ },
  manifest: { merge: "clean", minEngineVersion: "1.21.0" },
}}

// bepack.server.config.ts（BDS）
packs: { bp: {
  compile: { entry: "src/main.server.ts" },
  dependencies: { "@minecraft/server": "stable", "@minecraft/server-net": "beta", "@minecraft/server-admin": "beta" },
  manifest: { merge: "clean", minEngineVersion: "1.26.50" },
}}
```

要点：

- 两份都用 `manifest.merge: "clean"`，交替构建不会互相残留 managed 依赖；
- `@minecraft/server-net` / `server-admin` 是 beta，需在 BDS 上启用 **Beta APIs**；
- server-net 作为受管理依赖会被 rolldown 自动 external，不会打进产物；
- **`/server/server2` 之类的部署目标只放在 BDS 配置里**，普通版不要配 copy 目标，
  否则普通版会把 BDS 变体顶掉。

命令：

```bash
npm run build         # 普通版：只编译
npm run pack          # 普通版 .mcpack
npm run build:server  # BDS 版：编译并部署
npm run pack:server   # BDS 版 .mcpack
npm run copy:server   # 只复制 BDS 版
```

## 实机注意事项

- BDS 需要 `transport=nethernet`（否则玩家连不进来，与本次改动无关）。
- Beta APIs 开启后重启服务器，`@minecraft/server-net` 才会生效。
- 运行中切换 Trace Store 用 `/api/net/store`，或在游戏内命令里开关；BDS 变体
  默认关闭，靠 `restoreEnabled()` 恢复上次的设置，首次开服需要先用 Observatory
  的 `Store` 按钮或游戏内命令打开，否则没有历史可查。
- 同世界加载多个 BEGame 包时，每个包各连一条 trace net，Observatory 按
  `packId` 汇总；工作台会出现包选择器。
