import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveStore, Archiver, type ArchiveLiveGroup, type ArchiveLiveSession, type ArchiveSource } from "./archive";
import { createApp, PUBLIC_DIR } from "./app";
import { ConnectBridge } from "./connect";
import { IngestStore } from "./ingest";
import { TraceNetBridge } from "./net";
import { configCandidates, loadConfig } from "./config";
import { HELP_TEXT, parseServerOptions, type ServerOptions } from "./options";

/** Package root (`packages/observatory/`), independent of the process cwd. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const loaded = loadConfig(configCandidates(PACKAGE_ROOT, process.cwd()));
for (const warning of loaded.warnings) console.warn(`[observatory] ${warning}`);
if (loaded.path) console.log(`已加载配置：${loaded.path}`);

const parsed = parseServerOptions(process.argv.slice(2), process.env, loaded.config);
if (!parsed.ok) {
    // `--help` also arrives here; print it as information, not as an error.
    const isHelp = parsed.error === HELP_TEXT;
    (isHelp ? console.log : console.error)(parsed.error);
    process.exitCode = isHelp ? 0 : 2;
} else {
    start(parsed.options);
}

function start(options: ServerOptions) {
    const dataDir =
        options.ingestDir ??
        fileURLToPath(new URL("../data", import.meta.url));
    const ingestDir = dataDir;

    const bridge = options.connect
        ? new ConnectBridge(options.connectPort, options.host, options.connectTargets)
        : undefined;
    const ingest = options.ingest ? new IngestStore(ingestDir, options.ingestToken) : undefined;
    const net = options.net
        ? new TraceNetBridge(options.netPort, options.host, options.netToken)
        : undefined;

    // The archive mirrors finished sessions off the live bridges, so they
    // survive a disconnect or a game restart. It shares the ingest data root
    // but lives in its own subdirectory, leaving `IngestStore`'s listing alone.
    const archiveDir = options.archiveDir ?? join(dataDir, "archive");
    const archive = options.archive ? new ArchiveStore(archiveDir) : undefined;
    const archiver = archive
        ? new Archiver(archive, archiveSources(bridge, net), {
              onError: (error) => console.error("[observatory] 归档失败:", error),
          })
        : undefined;
    archiver?.start();

    if (!options.http) {
        console.log("HTTP 工作台未启用（--no-http）。");
        return;
    }

    if (!existsSync(join(PUBLIC_DIR, "build", "app.js"))) {
        console.warn("前端 bundle 不存在，请先运行 npm run build（npm run observatory 会自动构建）。");
    }

    const server = serve(
        {
            fetch: createApp(bridge, ingest, net, archive).fetch,
            port: options.port,
            hostname: options.host,
        },
        (info) => {
            console.log(`BEGame Observatory: http://${options.host}:${info.port}`);
            if (bridge) {
                console.log(`/connect 桥: ws://${options.host}:${options.connectPort}`);
                if (options.connectTargets.length === 0) {
                    console.warn(
                        "  未配置 namespace：连接后无法列出会话。" +
                            "请在 observatory.config.json 中设置 connect.targets，例如 " +
                            '{"connect":{"targets":{"ddz":{}}}}'
                    );
                } else {
                    console.log(
                        `  已配置包：${options.connectTargets
                            .map((target) => target.packName ?? target.namespace)
                            .join(", ")}`
                    );
                }
            }
            if (net) console.log(`BDS trace net: ws://${options.host}:${options.netPort}`);
            if (ingest) {
                console.log(`BDS ingest: POST http://${options.host}:${info.port}/api/ingest（目录 ${ingestDir}）`);
            }
            if (archive) console.log(`Trace 归档: ${archiveDir}`);
            console.log("Ctrl+C 停止");
        }
    );

    server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
            console.error(
                `端口 ${options.port} 已被占用，可用 --port <n> 或 PORT=<n> 换一个端口。`
            );
        } else {
            console.error(error);
        }
        process.exitCode = 1;
    });
}

/**
 * Adapts the live bridges to the archive's structural `ArchiveSource`. Kept in
 * the server entry so `archive.ts` stays free of bridge dependencies and easy
 * to unit test with fakes.
 */
function archiveSources(
    bridge: ConnectBridge | undefined,
    net: TraceNetBridge | undefined
): ArchiveSource[] {
    const sources: ArchiveSource[] = [];
    if (bridge) {
        sources.push({
            kind: "connect",
            async list(): Promise<readonly ArchiveLiveGroup[]> {
                const { sessions } = await bridge.list();
                const groups = new Map<
                    string,
                    { pack: string; packName?: string; sessions: ArchiveLiveSession[] }
                >();
                for (const target of bridge.configuredTargets) {
                    groups.set(target.namespace, {
                        pack: target.namespace,
                        packName: target.packName,
                        sessions: [],
                    });
                }
                for (const session of sessions) {
                    let group = groups.get(session.pack);
                    if (!group) {
                        group = { pack: session.pack, packName: session.packName, sessions: [] };
                        groups.set(session.pack, group);
                    }
                    group.sessions.push(session);
                }
                return [...groups.values()];
            },
            download: (pack, sessionId) => bridge.download(sessionId, pack),
            available: () => bridge.connected,
        });
    }
    if (net) {
        sources.push({
            kind: "net",
            async list(): Promise<readonly ArchiveLiveGroup[]> {
                const all = await net.listAll();
                return all.map((entry) => ({
                    pack: entry.source,
                    packName: entry.packName,
                    sessions: entry.sessions,
                }));
            },
            download: (pack, sessionId) => net.download(pack, sessionId),
            available: () => net.connected,
        });
    }
    return sources;
}
