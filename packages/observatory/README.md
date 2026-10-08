# @begame/observatory

BEGame 的 trace 分析工作台与服务端。可以作为独立包安装使用，不依赖 BEGame 仓库。

## 安装

```bash
npm i -g @begame/observatory
bgobs --help
```

或作为项目依赖：

```bash
npm i @begame/observatory
npx bgobs --connect
```

## 快速开始

```bash
# 只启动工作台 UI（默认 http://127.0.0.1:8787）
bgobs

# 启动 UI + 客户端 /connect 桥，并声明要查询的包
bgobs --connect --pack ddz
```

然后在 Minecraft 中（需要操作员权限）：

```
/connect ws://127.0.0.1:18789
```

## 配置文件

`/connect` 桥需要知道每个包的命令 namespace。Bedrock 规定一个 add-on 只能注册
**一个**自定义命令命名空间（否则抛 `NamespaceMismatch`），所以 ddz 包的命令是
`ddz:tracelist` 而不是 `begame:tracelist`——每个包都不一样，必须显式声明。

在进程工作目录或包根目录放 `observatory.config.json`：

```json
{
    "connect": {
        "targets": {
            "ddz": { "packName": "MCBE Dou Dizhu", "games": ["doudizhu"] }
        }
    }
}
```

`targets` 也可以写成数组：

```json
{
    "connect": {
        "targets": [
            { "namespace": "ddz", "packName": "MCBE Dou Dizhu" },
            { "namespace": "game", "packName": "PartyGames" }
        ]
    }
}
```

完整字段（全部可选）：

```json
{
    "host": "127.0.0.1",
    "port": 8787,
    "connect": {
        "port": 18789,
        "targets": { "ddz": {} }
    },
    "net": { "port": 18790, "token": "" },
    "ingest": { "dir": "./data", "token": "" },
    "archive": { "dir": "./data/archive" }
}
```

`observatory.config.example.json` 是一个可直接复制的模板。

## 配置优先级

命令行 > 环境变量 > 配置文件 > 默认值。

| 配置项 | 命令行 | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| HTTP 端口 | `--port` | `PORT` | 8787 |
| 监听地址 | `--host` | `HOST` | 127.0.0.1 |
| `/connect` 端口 | `--connect-port` | `BEGAME_CONNECT_PORT` | 18789 |
| 包 namespace | `--pack`（可重复） | — | 配置文件 |
| net 端口 | `--net-port` | `BEGAME_NET_PORT` | 18790 |
| net token | `--net-token` | `BEGAME_NET_TOKEN` | — |
| ingest 目录 | `--ingest-dir` | `BEGAME_INGEST_DIR` | 包内 `data` |
| ingest token | `--ingest-token` | `BEGAME_INGEST_TOKEN` | — |
| 归档目录 | `--archive-dir` | `BEGAME_ARCHIVE_DIR` | 包内 `data/archive` |
| 关闭归档 | `--no-archive` | — | 归档默认开启 |

命令行传了 `--pack` 就**替换**（而不是追加）配置文件里的列表。

## 三种接入方式

- `--connect` —— 客户端世界。Observatory 监听 WebSocket，游戏内 `/connect` 主动连入，
  通过自定义命令读取会话。与 `--net` 互斥。
- `--net` —— BDS 专用。游戏侧用 `@minecraft/server-net` 主动推送到 Observatory，
  支持多包按 `packId` 路由。
- `--ingest` —— HTTP 上传 sink（`POST /api/ingest`）。

三者中 HTTP 工作台默认开启，可用 `--no-http` 关闭。

## 断连后的持久化（本地归档）

`/connect` 与 `--net` 都是**实时查询代理**：会话本体在游戏侧的历史存储里，游戏一断连，
工作台列出来的记录就会消失。Observatory 默认会把它们的**已完成会话**拉取到本地磁盘
（`data/archive/<kind>/<pack>/<sessionId>.begtrace`），因此断连、甚至游戏重启后，工作台
仍会把这些会话列成「未连接」的数据源并标注「已归档」，可继续查看、导出，`/api/session/:id`
也优先从归档读取。

- 只归档 `status !== "running"` 的会话；进行中的会话继续走实时桥。
- 每 3 秒轮询一次、每次最多下载 5 局，避免 `/connect` 的单条命令队列被回填拖住。
- 显式删除（工作台 `×`）或「清空已完成」会连同归档一起删掉，否则记录会立刻「复活」。
- 用 `--no-archive` 关闭；`--archive-dir <path>` / `BEGAME_ARCHIVE_DIR` 换目录。

## 从源码构建

```bash
cd packages/observatory
npm i
npm run build
npm start
```

构建是自包含的（`scripts/build.mjs`），不需要 BEGame 仓库根目录参与。
