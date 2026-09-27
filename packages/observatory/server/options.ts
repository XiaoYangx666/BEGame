/**
 * Command-line / environment / config-file configuration for the Observatory
 * process.
 *
 * Nothing is opened unless asked for. The HTTP server (workbench UI + decode
 * API) is the only listener that starts by default; the `/connect` bridge and
 * the BDS `server-net` bridge are opt-in and mutually exclusive, because a
 * single Observatory is meant to serve one of the two game transports at a
 * time.
 *
 * Precedence, highest first: command line, environment, config file, defaults.
 */
import type { ConnectTarget, ObservatoryConfigFile } from "./config";

export interface ServerOptions {
    /** Serve the workbench UI and the HTTP API. */
    http: boolean;
    host: string;
    port: number;
    /** Client-world `/connect` bridge. */
    connect: boolean;
    connectPort: number;
    /**
     * Packs the `/connect` bridge queries. Empty means the bridge is listening
     * but cannot form a single command, which is reported at startup.
     */
    connectTargets: readonly ConnectTarget[];
    /** BDS `@minecraft/server-net` trace bridge. */
    net: boolean;
    netPort: number;
    netToken?: string;
    /** HTTP ingest sink (`POST /api/ingest`). */
    ingest: boolean;
    ingestDir?: string;
    ingestToken?: string;
    /**
     * Mirror finished sessions from the live bridges onto disk, so the
     * workbench keeps listing them after the game disconnects.
     */
    archive: boolean;
    archiveDir?: string;
    /** Path of the config file that was loaded, for diagnostics. */
    configPath?: string;
}

export type ParseResult =
    | { ok: true; options: ServerOptions }
    | { ok: false; error: string };

export const HELP_TEXT = `BEGame Observatory

用法：
  bgobs [选项]

默认只启动 HTTP 工作台（UI + 解码 API）。其余端口按需开启。

选项：
  --config <path>       指定配置文件（默认 observatory.config.json）
  --port <n>            HTTP 端口（默认 8787，环境变量 PORT）
  --host <addr>         监听地址（默认 127.0.0.1，环境变量 HOST）
  --connect             开启客户端 /connect 桥（与 --net 互斥）
  --connect-port <n>    /connect 端口（默认 18789，环境变量 BEGAME_CONNECT_PORT）
  --pack <ns>            声明一个包的命令 namespace，可重复
  --net                 开启 BDS server-net trace 桥（与 --connect 互斥）
  --net-port <n>        trace net 端口（默认 18790，环境变量 BEGAME_NET_PORT）
  --net-token <token>   trace net 握手 token（默认 BEGAME_NET_TOKEN）
  --ingest              开启 HTTP 上传 sink（POST /api/ingest）
  --ingest-dir <path>   上传落盘目录（默认 BEGAME_INGEST_DIR 或包内 data）
  --ingest-token <t>    上传 token（默认 BEGAME_INGEST_TOKEN）
  --no-archive          不把 /connect、net 的已完成会话镜像到本地磁盘
  --archive-dir <path>  归档目录（默认包内 data/archive）
  --no-http             不启动 HTTP 工作台，仅运行显式开启的桥
  -h, --help            显示本帮助

/connect 需要知道每个包的命令 namespace（Bedrock 规定一个包只能用一个
namespace，所以 ddz 包的命令是 ddz:tracelist，而不是 begame:tracelist）。
用配置文件声明：

  observatory.config.json
  {
    "connect": {
      "targets": { "ddz": { "packName": "MCBE Dou Dizhu" } }
    }
  }

示例：
  bgobs                             # 只有 UI
  bgobs --connect --pack ddz        # UI + /connect 桥，查询 ddz 包
  bgobs --net --ingest              # UI + BDS 桥 + 上传 sink
  bgobs --no-http --net             # 只运行 BDS 桥
`;

const CONNECT_PORT_DEFAULT = 18789;
const NET_PORT_DEFAULT = 18790;
const HTTP_PORT_DEFAULT = 8787;

function parsePort(
    raw: string,
    label: string
): { ok: true; value: number } | { ok: false; error: string } {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
        return { ok: false, error: `${label} 不是有效端口：${raw}` };
    }
    return { ok: true, value };
}

type Env = Record<string, string | undefined>;

/** Builds one connect target from a CLI `--pack` value. */
function packTarget(raw: string, warnings: string[]): ConnectTarget | undefined {
    const namespace = raw.trim();
    if (!/^[a-z0-9_]+$/.test(namespace)) {
        warnings.push(`忽略无效的 --pack：${JSON.stringify(raw)}`);
        return undefined;
    }
    return { namespace };
}

/**
 * Parses argv (without `node` / script), environment and an optional config
 * file. Environment variables may supply values, but never turn a listener on
 * by themselves; only the command line (or a config file) does that.
 */
export function parseServerOptions(
    argv: readonly string[],
    env: Env,
    config: ObservatoryConfigFile = {}
): ParseResult {
    const warnings: string[] = [];
    const options: ServerOptions = {
        http: true,
        host: env.HOST ?? config.host ?? "127.0.0.1",
        port: HTTP_PORT_DEFAULT,
        connect: false,
        connectPort: CONNECT_PORT_DEFAULT,
        connectTargets: [],
        net: false,
        netPort: NET_PORT_DEFAULT,
        ingest: false,
        archive: true,
    };

    if (config.port !== undefined) options.port = config.port;
    if (config.connect?.port !== undefined) options.connectPort = config.connect.port;
    if (config.net?.port !== undefined) options.netPort = config.net.port;
    options.ingestDir = config.ingest?.dir;
    options.ingestToken = config.ingest?.token;
    options.netToken = config.net?.token;
    options.archiveDir = config.archive?.dir;
    // A config file listing targets is itself a request to use the bridge.
    const configuredTargets = config.connect?.targets ?? [];
    if (configuredTargets.length > 0) options.connect = true;

    if (env.PORT !== undefined) {
        const parsed = parsePort(env.PORT, "PORT");
        if (!parsed.ok) return parsed;
        options.port = parsed.value;
    }
    if (env.BEGAME_CONNECT_PORT !== undefined) {
        const parsed = parsePort(env.BEGAME_CONNECT_PORT, "BEGAME_CONNECT_PORT");
        if (!parsed.ok) return parsed;
        options.connectPort = parsed.value;
    }
    if (env.BEGAME_NET_PORT !== undefined) {
        const parsed = parsePort(env.BEGAME_NET_PORT, "BEGAME_NET_PORT");
        if (!parsed.ok) return parsed;
        options.netPort = parsed.value;
    }
    options.ingestToken = env.BEGAME_INGEST_TOKEN ?? options.ingestToken;
    options.netToken = env.BEGAME_NET_TOKEN ?? env.BEGAME_INGEST_TOKEN ?? options.netToken;
    options.ingestDir = env.BEGAME_INGEST_DIR ?? options.ingestDir;
    options.archiveDir = env.BEGAME_ARCHIVE_DIR ?? options.archiveDir;

    // Collected separately so a CLI `--pack` replaces, rather than appends to,
    // the configured list: the command line is the higher-precedence source.
    let cliTargets: ConnectTarget[] | undefined;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = (): string | undefined => {
            const value = argv[++index];
            return value;
        };
        switch (arg) {
            case "-h":
            case "--help":
                return { ok: false, error: HELP_TEXT };
            case "--no-http":
                options.http = false;
                break;
            case "--connect":
                options.connect = true;
                break;
            case "--net":
                options.net = true;
                break;
            case "--ingest":
                options.ingest = true;
                break;
            case "--no-archive":
                options.archive = false;
                break;
            case "--pack": {
                const value = next();
                if (value === undefined) return { ok: false, error: "--pack 需要一个 namespace" };
                const target = packTarget(value, warnings);
                if (target) (cliTargets ??= []).push(target);
                break;
            }
            case "--host": {
                const value = next();
                if (value === undefined) return { ok: false, error: "--host 需要一个地址" };
                options.host = value;
                break;
            }
            case "--port":
            case "--connect-port":
            case "--net-port": {
                const value = next();
                if (value === undefined) return { ok: false, error: `${arg} 需要一个端口` };
                const parsed = parsePort(value, arg);
                if (!parsed.ok) return parsed;
                if (arg === "--port") options.port = parsed.value;
                else if (arg === "--connect-port") options.connectPort = parsed.value;
                else options.netPort = parsed.value;
                break;
            }
            case "--net-token": {
                const value = next();
                if (value === undefined) return { ok: false, error: "--net-token 需要一个值" };
                options.netToken = value;
                break;
            }
            case "--ingest-token": {
                const value = next();
                if (value === undefined) return { ok: false, error: "--ingest-token 需要一个值" };
                options.ingestToken = value;
                options.netToken ??= value;
                break;
            }
            case "--ingest-dir": {
                const value = next();
                if (value === undefined) return { ok: false, error: "--ingest-dir 需要一个路径" };
                options.ingestDir = value;
                options.ingest = true;
                break;
            }
            case "--archive-dir": {
                const value = next();
                if (value === undefined) return { ok: false, error: "--archive-dir 需要一个路径" };
                options.archiveDir = value;
                options.archive = true;
                break;
            }
            default:
                return { ok: false, error: `未知参数：${arg}（用 --help 查看用法）` };
        }
    }

    const seen = new Set<string>();
    options.connectTargets = (cliTargets ?? configuredTargets).filter((target) => {
        if (seen.has(target.namespace)) return false;
        seen.add(target.namespace);
        return true;
    });

    if (warnings.length > 0) {
        for (const warning of warnings) console.warn(`[observatory] ${warning}`);
    }

    if (options.connect && options.net) {
        return {
            ok: false,
            error:
                "不能同时开启 --connect 和 --net：/connect 桥与 BDS server-net 桥对应两种互斥的游戏接入方式，请只选其一。",
        };
    }
    if (!options.http && !options.connect && !options.net) {
        return {
            ok: false,
            error: "没有任何可启动的服务：至少需要 HTTP（默认开启）或 --connect / --net 之一。",
        };
    }

    return { ok: true, options };
}
