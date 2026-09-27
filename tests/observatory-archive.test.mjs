import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { decodeBegTrace, encodeBegTrace } from "../packages/trace/dist/index.js";
import { ArchiveStore, Archiver } from "../packages/observatory/server/archive.ts";
import { createApp } from "../packages/observatory/server/app.ts";

function traceBytes(sessionId, gameType = "archive-test") {
    return Buffer.from(
        encodeBegTrace(
            {
                sessionId,
                formatVersion: 1,
                gameType,
                gameKey: `${gameType}:0`,
                gameInstanceId: sessionId,
                startTick: 0,
                startWallTime: 100,
            },
            [],
            {
                sessionId,
                status: "completed",
                endTick: 10,
                endWallTime: 200,
                endReason: "test",
                eventCount: 0,
                chunkCount: 0,
            }
        )
    );
}

function summary(sessionId, extra = {}) {
    return {
        sessionId,
        gameType: "archive-test",
        gameKey: "archive-test:0",
        status: "completed",
        startWallTime: 100,
        eventCount: 0,
        chunkCount: 0,
        ...extra,
    };
}

async function withArchive(run) {
    const dir = mkdtempSync(join(tmpdir(), "begame-archive-"));
    try {
        return await run(new ArchiveStore(dir), dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("the archive round-trips a finished session per source", async () => {
    await withArchive(async (archive) => {
        const bytes = traceBytes("net-1");
        const saved = archive.save("net", "partygames", "小游戏行为包", summary("net-1"), bytes);

        expect(saved.kind).toBe("net");
        expect(saved.pack).toBe("partygames");
        expect(archive.has("net", "partygames", "net-1")).toBe(true);
        expect(archive.has("net", "ddz", "net-1")).toBe(false);
        expect(archive.read("net", "partygames", "net-1").equals(bytes)).toBe(true);

        const listed = archive.list();
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            kind: "net",
            pack: "partygames",
            packName: "小游戏行为包",
            session: { sessionId: "net-1", gameType: "archive-test", storedBytes: bytes.length },
        });

        expect(archive.remove("net", "partygames", "net-1")).toBe(true);
        expect(archive.has("net", "partygames", "net-1")).toBe(false);

        archive.save("connect", "ddz", "DDZ", summary("c-1"), traceBytes("c-1"));
        archive.save("connect", "ddz", "DDZ", summary("c-2"), traceBytes("c-2"));
        expect(archive.clear("connect", "ddz")).toBe(2);
        expect(archive.list()).toEqual([]);
    });
});

test("the archiver pulls finished sessions and skips running ones", async () => {
    await withArchive(async (archive) => {
        const downloads = [];
        const source = {
            kind: "net",
            async list() {
                return [
                    {
                        pack: "pg",
                        packName: "PG",
                        sessions: [
                            summary("done-1"),
                            summary("run-1", { status: "running" }),
                        ],
                    },
                ];
            },
            async download(pack, sessionId) {
                downloads.push(`${pack}/${sessionId}`);
                return traceBytes(sessionId);
            },
        };

        const archiver = new Archiver(archive, [source]);
        expect(await archiver.sweep()).toBe(1);
        expect(archive.has("net", "pg", "done-1")).toBe(true);
        expect(archive.has("net", "pg", "run-1")).toBe(false);
        expect(downloads).toEqual(["pg/done-1"]);

        // Already-archived sessions are not fetched again.
        expect(await archiver.sweep()).toBe(0);
    });
});

test("maxPerSweep spreads a backfill across polls", async () => {
    await withArchive(async (archive) => {
        const source = {
            kind: "connect",
            async list() {
                return [
                    {
                        pack: "ddz",
                        sessions: [summary("a"), summary("b"), summary("c")],
                    },
                ];
            },
            async download(_pack, sessionId) {
                return traceBytes(sessionId);
            },
        };
        const archiver = new Archiver(archive, [source], { maxPerSweep: 1 });
        expect(await archiver.sweep()).toBe(1);
        expect(await archiver.sweep()).toBe(1);
        expect(await archiver.sweep()).toBe(1);
        expect(await archiver.sweep()).toBe(0);
        expect(archive.list()).toHaveLength(3);
    });
});

test("an unavailable source is skipped without listing", async () => {
    await withArchive(async (archive) => {
        let calls = 0;
        const source = {
            kind: "connect",
            available: () => false,
            async list() {
                calls++;
                return [];
            },
            async download() {
                throw new Error("should not be called");
            },
        };
        const archiver = new Archiver(archive, [source]);
        expect(await archiver.sweep()).toBe(0);
        expect(calls).toBe(0);
    });
});

test("archived sources are listed and served with nothing connected", async () => {
    await withArchive(async (archive) => {
        archive.save("net", "partygames", "小游戏行为包", summary("net-1"), traceBytes("net-1"));
        archive.save("connect", "ddz", "DDZ", summary("c-1"), traceBytes("c-1"));
        const app = createApp(undefined, undefined, undefined, archive);

        const body = await (await app.request("/api/sessions")).json();
        expect(body.capabilities.archive).toBe(true);

        const net = body.sources.find((entry) => entry.id === "net:partygames");
        expect(net.connected).toBe(false);
        expect(net.packName).toBe("小游戏行为包");
        expect(net.sessions).toHaveLength(1);
        expect(net.sessions[0]).toMatchObject({ sessionId: "net-1", archived: true });

        const connect = body.sources.find((entry) => entry.id === "connect:ddz");
        expect(connect.connected).toBe(false);
        expect(connect.sessions[0]).toMatchObject({ sessionId: "c-1", archived: true });

        const netTrace = await app.request("/api/session/net-1?source=net&pack=partygames");
        expect(netTrace.status).toBe(200);
        expect(decodeBegTrace(new Uint8Array(await netTrace.arrayBuffer())).header.sessionId).toBe("net-1");

        const connectTrace = await app.request("/api/session/c-1?source=connect&pack=ddz");
        expect(connectTrace.status).toBe(200);

        // Deleting an archived session removes the on-disk copy even offline.
        const deleted = await app.request("/api/net/session/net-1?source=partygames", {
            method: "DELETE",
        });
        expect((await deleted.json()).deleted).toBe(true);
        expect(archive.has("net", "partygames", "net-1")).toBe(false);
    });
});

test("a live session wins over its archived copy", async () => {
    await withArchive(async (archive) => {
        archive.save("connect", "ddz", "DDZ", summary("live-1"), traceBytes("live-1"));
        archive.save("connect", "ddz", "DDZ", summary("old-1", { startWallTime: 1 }), traceBytes("old-1"));

        const bridge = {
            connected: true,
            configuredTargets: [{ namespace: "ddz", packName: "DDZ" }],
            async list() {
                return {
                    sessions: [{ ...summary("live-1", { startWallTime: 50 }), pack: "ddz", packName: "DDZ" }],
                    errors: [],
                };
            },
            async download(id) {
                return traceBytes(id);
            },
        };
        const app = createApp(bridge, undefined, undefined, archive);

        const body = await (await app.request("/api/sessions")).json();
        const group = body.sources.find((entry) => entry.id === "connect:ddz");
        expect(group.connected).toBe(true);
        expect(group.sessions.map((session) => session.sessionId)).toEqual(["live-1", "old-1"]);
        expect(group.sessions.find((session) => session.sessionId === "live-1").archived).toBeUndefined();
        expect(group.sessions.find((session) => session.sessionId === "old-1").archived).toBe(true);
    });
});

test("archived sessions still export while the bridge is offline", async () => {
    await withArchive(async (archive) => {
        archive.save("net", "pg", "PG", summary("net-1"), traceBytes("net-1"));
        archive.save("connect", "ddz", "DDZ", summary("c-1"), traceBytes("c-1"));
        const app = createApp(undefined, undefined, undefined, archive);

        const net = await app.request("/api/net/export", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: [{ source: "pg", id: "net-1" }] }),
        });
        expect(net.status).toBe(200);
        expect(net.headers.get("content-type")).toBe("application/zip");

        const connect = await app.request("/api/connect/export", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: ["c-1"], pack: "ddz" }),
        });
        expect(connect.status).toBe(200);
        expect(connect.headers.get("content-type")).toBe("application/zip");
    });
});
