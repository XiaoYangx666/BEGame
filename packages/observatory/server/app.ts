import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { decodeTracePayload } from "../src/decode.mjs";
import type { DecodeResponse } from "../src/types";
import type { ArchiveRecord, ArchiveStore } from "./archive";
import type { ConnectBridge, LiveSummary as ConnectLiveSession } from "./connect";
import type { IngestStore } from "./ingest";
import type { TraceNetBridge } from "./net";
import { zipFiles } from "./zip";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const VERSION = "0.0.2";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
/** Bedrock command namespaces are lowercase alphanumerics/underscore only. */
const NAMESPACE_PATTERN = /^[a-z0-9_]+$/;

/**
 * A pack namespace is mandatory wherever a session is fetched from the
 * `/connect` bridge, because the bridge commands are registered per pack
 * (`ddz:tracelist`, `game:tracelist`, ...). Failing here keeps the error
 * legible instead of sending a malformed command to the game.
 */
function requirePack(pack: string | undefined): string {
    if (!pack) throw new Error("connect 数据源需要 pack 参数（包的命令 namespace）");
    if (!NAMESPACE_PATTERN.test(pack)) throw new Error(`无效的 pack namespace：${pack}`);
    return pack;
}

/** Absolute path of the static assets, independent of the process cwd. */
export const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

interface AppDeps {
    bridge?: ConnectBridge;
    ingest?: IngestStore;
    net?: TraceNetBridge;
    archive?: ArchiveStore;
}

export function createApp(bridge?: ConnectBridge, ingest?: IngestStore, net?: TraceNetBridge, archive?: ArchiveStore) {
    const app = new Hono();
    const deps: AppDeps = { bridge, ingest, net, archive };

    app.get("/api/health", (c) =>
        c.json({
            ok: true,
            name: "@begame/observatory",
            version: VERSION,
            capabilities: capabilities(deps),
        })
    );

    // ------------------------------------------------------------------
    // Decode / analyze
    // ------------------------------------------------------------------

    app.post("/api/decode", async (c) => {
        const body = await readBody(c, MAX_BODY_BYTES);
        if (!body.ok) return c.json({ ok: false, error: body.error, exports: [] }, body.status);
        const sessionId = c.req.query("session") || undefined;
        const result = decodeSafely(body.buffer, sessionId);
        return c.json(result, result.ok ? 200 : 422);
    });

    /** Decode + analyze an uploaded payload; the response stays analysis-only. */
    app.post("/api/analyze", async (c) => {
        const body = await readBody(c, MAX_BODY_BYTES);
        if (!body.ok) return c.json({ ok: false, error: body.error }, body.status);
        const sessionId = c.req.query("session") || undefined;
        return c.json(analyzePayload(body.buffer, sessionId));
    });

    /** Analyze a session already held by one of the configured sources. */
    app.get("/api/analyze", async (c) => {
        const source = c.req.query("source");
        const id = c.req.query("id");
        if (!source || !id) return c.json({ ok: false, error: "缺少 source / id 参数" }, 400);
        try {
            const bytes = await fetchSessionBytes(deps, source, id, c.req.query("pack"));
            return c.json(analyzePayload(bytes));
        } catch (error) {
            return c.json({ ok: false, error: (error as Error).message }, 422);
        }
    });

    // ------------------------------------------------------------------
    // Unified source / session surface
    // ------------------------------------------------------------------

    /** Every configured source, whether or not it is currently connected. */
    app.get("/api/sources", (c) => c.json({ capabilities: capabilities(deps), sources: sourceSummary(deps) }));

    /** All sessions from every connected source, flattened and tagged. */
    app.get("/api/sessions", async (c) => {
        const sources: unknown[] = [];
        // Archived sessions are surfaced even when their bridge is off: that is
        // the whole point of persisting them. A live source of the same pack is
        // listed once, with its finished sessions merged in.
        const archived = archive?.list() ?? [];
        const seen = new Set<string>();

        if (bridge) {
            let live: ConnectLiveSession[] = [];
            let errors: { pack: string; error: string }[] = [];
            let listError: string | undefined;
            try {
                ({ sessions: live, errors } = await bridge.list());
            } catch (error) {
                listError = (error as Error).message;
            }
            // Mirror the net source: one entry per pack, so the workbench can
            // group sessions by pack instead of showing one flat list.
            for (const target of bridge.configuredTargets) {
                const failure = errors.find((item) => item.pack === target.namespace);
                const list = live.filter((session) => session.pack === target.namespace);
                sources.push({
                    id: `connect:${target.namespace}`,
                    kind: "connect",
                    connected: bridge.connected,
                    pack: target.namespace,
                    packName: target.packName ?? target.namespace,
                    sessions: mergeArchived(list, archived, "connect", target.namespace),
                    // A connection-level failure is already conveyed by the
                    // disconnected dot; only per-pack failures add detail.
                    error: failure?.error ?? (bridge.connected ? listError : undefined),
                });
                seen.add(`connect:${target.namespace}`);
            }
        }
        if (net) {
            try {
                const all = await net.listAll();
                for (const entry of all) {
                    sources.push({
                        id: `net:${entry.source}`,
                        kind: "net",
                        connected: true,
                        pack: entry.source,
                        packName: entry.packName,
                        store: entry.store,
                        sessions: mergeArchived(entry.sessions, archived, "net", entry.source),
                        error: entry.error,
                    });
                    seen.add(`net:${entry.source}`);
                }
            } catch (error) {
                sources.push({ id: "net", kind: "net", connected: net.connected, sessions: [], error: (error as Error).message });
            }
        }
        if (ingest) {
            sources.push({ id: "ingest", kind: "ingest", connected: true, sessions: ingest.list() });
        }
        for (const source of archiveSources(archived)) {
            const id = `${source.kind}:${source.pack}`;
            if (seen.has(id)) continue;
            sources.push({
                id,
                kind: source.kind,
                connected: false,
                pack: source.pack,
                packName: source.packName ?? source.pack,
                sessions: mergeArchived([], archived, source.kind, source.pack),
            });
        }

        return c.json({ capabilities: capabilities(deps), sources });
    });

    /** Raw `.begtrace` bytes for a session, or `?format=json` for the decoded session. */
    app.get("/api/session/:id", async (c) => {
        const source = c.req.query("source");
        if (!source) return c.json({ error: "缺少 source 参数" }, 400);
        const id = c.req.param("id");
        try {
            const bytes = await fetchSessionBytes(deps, source, id, c.req.query("pack"));
            if (c.req.query("format") === "json") {
                return c.json(decodeSafely(bytes));
            }
            return new Response(new Uint8Array(bytes), {
                headers: {
                    "content-type": "application/octet-stream",
                    "content-disposition": `attachment; filename="${id}.begtrace"`,
                    "cache-control": "no-store",
                },
            });
        } catch (error) {
            return c.json({ error: (error as Error).message }, 422);
        }
    });

    // ------------------------------------------------------------------
    // /connect bridge
    // ------------------------------------------------------------------

    app.get("/api/connect/status", (c) =>
        c.json({
            enabled: Boolean(bridge),
            connected: bridge?.connected ?? false,
            url: bridge?.url,
            targets: bridge?.configuredTargets ?? [],
        })
    );
    app.get("/api/connect/sessions", async (c) => {
        if (!bridge) return c.json({ error: "连接服务未启动" }, 503);
        try {
            const pack = c.req.query("pack");
            // A single pack keeps the flat shape callers already used; without
            // `pack` the response spans every configured namespace.
            if (pack) return c.json({ sessions: await bridge.listPack(pack) });
            return c.json(await bridge.list());
        } catch (error) { return c.json({ error: (error as Error).message }, 503); }
    });
    app.get("/api/connect/session/:id", async (c) => {
        if (!bridge) return c.json({ error: "连接服务未启动" }, 503);
        try {
            const pack = requirePack(c.req.query("pack"));
            const bytes = await bridge.download(c.req.param("id"), pack);
            return new Response(new Uint8Array(bytes), {
                headers: {
                    "content-type": "application/octet-stream",
                    "content-disposition": `attachment; filename="${c.req.param("id")}.begtrace"`,
                    "cache-control": "no-store",
                },
            });
        } catch (error) { return c.json({ error: (error as Error).message }, 422); }
    });
    app.post("/api/connect/export", async (c) => {
        if (!bridge && !archive) return c.json({ error: "连接服务未启动" }, 503);
        try {
            const body = await c.req.json() as { ids?: unknown; pack?: unknown };
            const ids = body.ids;
            if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every((id) => typeof id === "string" && ID_PATTERN.test(id))) {
                return c.json({ error: "请选择 1 至 500 个有效会话" }, 400);
            }
            const pack = requirePack(typeof body.pack === "string" ? body.pack : c.req.query("pack"));
            const files = [];
            let total = 0;
            for (const id of new Set(ids as string[])) {
                const bytes =
                    archive?.read("connect", pack, id) ??
                    (bridge ? await bridge.download(id, pack) : undefined);
                if (!bytes) throw new Error(`未找到会话 ${id}`);
                total += bytes.length;
                if (total > MAX_BODY_BYTES) return c.json({ error: "归档超过 64 MiB，请分批导出" }, 413);
                files.push({ name: `${id}.begtrace`, bytes });
            }
            return new Response(new Uint8Array(zipFiles(files)), {
                headers: { "content-type": "application/zip", "content-disposition": "attachment; filename=begame-traces.zip", "cache-control": "no-store" },
            });
        } catch (error) { return c.json({ error: (error as Error).message }, 422); }
    });

    // ------------------------------------------------------------------
    // HTTP ingest sink
    // ------------------------------------------------------------------

    app.get("/api/ingest/status", (c) =>
        c.json({ enabled: Boolean(ingest), count: ingest?.list().length ?? 0 })
    );

    app.post("/api/ingest", async (c) => {
        if (!ingest) return c.json({ error: "ingest 未启用" }, 503);
        if (!ingest.authorize(c.req.header("x-begame-token"))) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const length = Number(c.req.header("content-length") ?? 0);
        if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
            return c.json({ error: "上传体过大（上限 64 MiB）" }, 413);
        }
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: "无效的 JSON 上传分片" }, 400);
        }
        const result = ingest.accept(body);
        return c.json(result, result.ok ? 202 : result.code);
    });

    app.get("/api/ingest/sessions", (c) => {
        if (!ingest) return c.json({ error: "ingest 未启用" }, 503);
        return c.json({ sessions: ingest.list() });
    });

    app.get("/api/ingest/session/:id", (c) => {
        if (!ingest) return c.json({ error: "ingest 未启用" }, 503);
        const bytes = ingest.read(c.req.param("id"));
        if (!bytes) return c.json({ error: "未找到会话" }, 404);
        return new Response(new Uint8Array(bytes), {
            headers: {
                "content-type": "application/octet-stream",
                "content-disposition": `attachment; filename="${c.req.param("id")}.begtrace"`,
                "cache-control": "no-store",
            },
        });
    });

    // ------------------------------------------------------------------
    // BDS trace net
    // ------------------------------------------------------------------

    app.get("/api/net/status", (c) => {
        if (!net) return c.json({ enabled: false, connected: false, sources: [] });
        return c.json({ enabled: true, connected: net.connected, sources: net.sources() });
    });

    app.get("/api/net/sessions", async (c) => {
        if (!net) return c.json({ error: "trace net 未启用" }, 503);
        try {
            return c.json({ sources: await net.listAll() });
        } catch (error) {
            return c.json({ error: (error as Error).message }, 503);
        }
    });

    app.get("/api/net/session/:id", async (c) => {
        const source = c.req.query("source");
        if (!source) return c.json({ error: "缺少 source 参数" }, 400);
        try {
            const id = c.req.param("id");
            const bytes =
                archive?.read("net", source, id) ??
                (net ? await net.download(source, id) : undefined);
            if (!bytes) return c.json({ error: net ? "未找到会话" : "trace net 未启用" }, net ? 404 : 503);
            return new Response(new Uint8Array(bytes), {
                headers: {
                    "content-type": "application/octet-stream",
                    "content-disposition": `attachment; filename="${id}.begtrace"`,
                    "cache-control": "no-store",
                },
            });
        } catch (error) {
            return c.json({ error: (error as Error).message }, 422);
        }
    });

    app.delete("/api/net/session/:id", async (c) => {
        if (!net && !archive) return c.json({ error: "trace net 未启用" }, 503);
        const source = c.req.query("source");
        if (!source) return c.json({ error: "缺少 source 参数" }, 400);
        const id = c.req.param("id");
        // The archive is a copy, not the source of truth: an explicit delete
        // must drop both, otherwise the row would immediately reappear.
        let deleted = archive?.remove("net", source, id) ?? false;
        if (net) {
            try {
                if (await net.remove(source, id)) deleted = true;
            } catch {
                // The pack may be offline; the archived copy was still removed.
            }
        }
        return c.json({ deleted });
    });

    app.post("/api/net/clear", async (c) => {
        if (!net && !archive) return c.json({ error: "trace net 未启用" }, 503);
        let source: unknown;
        try {
            source = (await c.req.json()).source;
        } catch {
            return c.json({ error: "无效的 JSON" }, 400);
        }
        if (typeof source !== "string" || source.length === 0) {
            return c.json({ error: "缺少 source" }, 400);
        }
        let removed = archive?.clear("net", source) ?? 0;
        if (net) {
            try {
                removed += await net.clear(source);
            } catch {
                // Clearing is best-effort while the pack is offline.
            }
        }
        return c.json({ removed });
    });

    app.post("/api/net/store", async (c) => {
        if (!net) return c.json({ error: "trace net 未启用" }, 503);
        let body: { source?: unknown; enabled?: unknown };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: "无效的 JSON" }, 400);
        }
        if (typeof body.source !== "string" || body.source.length === 0) {
            return c.json({ error: "缺少 source" }, 400);
        }
        if (typeof body.enabled !== "boolean") {
            return c.json({ error: "enabled 必须是布尔值" }, 400);
        }
        try {
            return c.json({ store: await net.setStore(body.source, body.enabled) });
        } catch (error) {
            return c.json({ error: (error as Error).message }, 422);
        }
    });

    app.post("/api/net/export", async (c) => {
        if (!net && !archive) return c.json({ error: "trace net 未启用" }, 503);
        try {
            const body = (await c.req.json()) as { items?: unknown };
            const items = body.items;
            if (
                !Array.isArray(items) ||
                items.length === 0 ||
                items.length > 500 ||
                !items.every(
                    (item) =>
                        typeof item === "object" &&
                        item !== null &&
                        typeof (item as { source?: unknown }).source === "string" &&
                        typeof (item as { id?: unknown }).id === "string" &&
                        ID_PATTERN.test((item as { id: string }).id)
                )
            ) {
                return c.json({ error: "请选择 1 至 500 个有效会话" }, 400);
            }
            const files = [];
            let total = 0;
            const seen = new Set<string>();
            for (const item of items as { source: string; id: string }[]) {
                const key = `${item.source}/${item.id}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const bytes =
                    archive?.read("net", item.source, item.id) ??
                    (net ? await net.download(item.source, item.id) : undefined);
                if (!bytes) throw new Error(`未找到会话 ${item.id}`);
                total += bytes.length;
                if (total > MAX_BODY_BYTES) {
                    return c.json({ error: "归档超过 64 MiB，请分批导出" }, 413);
                }
                files.push({ name: `${item.source}-${item.id}.begtrace`, bytes });
            }
            return new Response(new Uint8Array(zipFiles(files)), {
                headers: {
                    "content-type": "application/zip",
                    "content-disposition": "attachment; filename=begame-bds-traces.zip",
                    "cache-control": "no-store",
                },
            });
        } catch (error) {
            return c.json({ error: (error as Error).message }, 422);
        }
    });

    app.get("/", serveStatic({ path: "/index.html", root: PUBLIC_DIR }));
    app.use("/*", serveStatic({ root: PUBLIC_DIR }));

    return app;
}

function capabilities(deps: AppDeps) {
    return {
        http: true,
        connect: Boolean(deps.bridge),
        // Distinguishes "bridge listening but no pack configured" from
        // "bridge ready": the former cannot answer a single command.
        connectTargets: deps.bridge?.configuredTargets.length ?? 0,
        net: Boolean(deps.net),
        ingest: Boolean(deps.ingest),
        archive: Boolean(deps.archive),
    };
}

function sourceSummary(deps: AppDeps) {
    const sources: Array<{ id: string; kind: string; enabled: boolean }> = [];
    if (deps.bridge) sources.push({ id: "connect", kind: "connect", enabled: true });
    if (deps.net) sources.push({ id: "net", kind: "net", enabled: true });
    if (deps.ingest) sources.push({ id: "ingest", kind: "ingest", enabled: true });
    return sources;
}

type BodyResult =
    | { ok: true; buffer: Buffer }
    | { ok: false; status: 400 | 413; error: string };

async function readBody(c: { req: { header(name: string): string | undefined; arrayBuffer(): Promise<ArrayBuffer> } }, limit: number): Promise<BodyResult> {
    const length = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(length) && length > limit) {
        return { ok: false, status: 413, error: "请求体过大（上限 64 MiB）" };
    }
    const buffer = Buffer.from(await c.req.arrayBuffer());
    if (buffer.length === 0) return { ok: false, status: 400, error: "请求体为空" };
    return { ok: true, buffer };
}

function decodeSafely(buffer: Buffer, sessionId?: string): DecodeResponse {
    try {
        return decodeTracePayload(buffer, sessionId);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            exports: [],
        };
    }
}

function analyzePayload(buffer: Buffer, sessionId?: string) {
    const result = decodeSafely(buffer, sessionId);
    if (!result.ok || !result.selected) {
        return { ok: false, error: result.error ?? "解析失败", exports: result.exports ?? [] };
    }
    return {
        ok: true,
        source: result.source,
        analysis: result.analysis,
        warnings: result.warnings ?? [],
    };
}

/** Resolve raw bytes for one session, by source kind. */async function fetchSessionBytes(
    deps: AppDeps,
    source: string,
    id: string,
    pack?: string
): Promise<Buffer> {
    if (!ID_PATTERN.test(id)) throw new Error("无效的会话 ID");
    if (source === "connect") {
        // Command names are namespaced per pack, so the pack is not optional.
        const namespace = requirePack(pack);
        // A finished session is served from the archive first: it is immutable,
        // needs no round-trip, and still exists after the game disconnects.
        const archived = deps.archive?.read("connect", namespace, id);
        if (archived) return archived;
        if (!deps.bridge) throw new Error("连接服务未启动");
        return deps.bridge.download(id, namespace);
    }
    if (source === "ingest") {
        if (!deps.ingest) throw new Error("ingest 未启用");
        const bytes = deps.ingest.read(id);
        if (!bytes) throw new Error("未找到会话");
        return bytes;
    }
    if (source === "net") {
        if (!pack) throw new Error("net 数据源需要 pack 参数");
        const archived = deps.archive?.read("net", pack, id);
        if (archived) return archived;
        if (!deps.net) throw new Error("trace net 未启用");
        return deps.net.download(pack, id);
    }
    throw new Error(`未知数据源：${source}`);
}

interface ArchiveSourceSummary {
    kind: ArchiveRecord["kind"];
    pack: string;
    packName?: string;
}

/** Distinct sources present in the archive, first (newest) label winning. */
function archiveSources(records: readonly ArchiveRecord[]): ArchiveSourceSummary[] {
    const byKey = new Map<string, ArchiveSourceSummary>();
    for (const record of records) {
        const key = `${record.kind}\u0000${record.pack}`;
        const existing = byKey.get(key);
        if (existing) {
            if (!existing.packName && record.packName) existing.packName = record.packName;
            continue;
        }
        byKey.set(key, {
            kind: record.kind,
            pack: record.pack,
            ...(record.packName ? { packName: record.packName } : {}),
        });
    }
    return [...byKey.values()];
}

/**
 * Live sessions plus archived ones the live list no longer has. A finished
 * session is immutable, so the live row wins when both exist — it may still
 * carry store state the archive copy does not.
 */
function mergeArchived<T extends { sessionId: string; startWallTime?: number }>(
    live: readonly T[],
    records: readonly ArchiveRecord[],
    kind: ArchiveRecord["kind"],
    pack: string
): unknown[] {
    const liveIds = new Set(live.map((session) => session.sessionId));
    const extra = records
        .filter(
            (record) =>
                record.kind === kind &&
                record.pack === pack &&
                !liveIds.has(record.session.sessionId)
        )
        .map((record) => ({
            ...record.session,
            archived: true as const,
            storedAt: record.storedAt,
        }));
    const merged: { sessionId: string; startWallTime?: number }[] = [...live, ...extra];
    merged.sort((a, b) => (b.startWallTime ?? 0) - (a.startWallTime ?? 0));
    return merged;
}
