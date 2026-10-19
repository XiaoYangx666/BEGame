import { expect, test } from "vitest";
import {
    encodeBase64,
    encodeBegTrace,
    TRACE_NET_VERSION,
} from "../packages/trace/dist/index.js";
import { TraceNetBridge } from "../packages/observatory/server/net.ts";

async function listening(bridge) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const port = bridge.boundPort;
        if (port > 0) return port;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("bridge did not start listening");
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("condition not met");
}

function traceBytes(sessionId) {
    return Buffer.from(
        encodeBegTrace(
            {
                sessionId,
                formatVersion: 1,
                gameType: "net-test",
                gameKey: `net-test:${sessionId}`,
                gameInstanceId: sessionId,
                startTick: 0,
                startWallTime: 0,
            },
            [],
            {
                sessionId,
                status: "completed",
                endTick: 10,
                endWallTime: 100,
                eventCount: 0,
                chunkCount: 0,
            }
        )
    );
}

/** A scripted stand-in for one BDS pack. */
function fakeGame(socket, sessionId, options = {}) {
    const summaries = new Map();
    const state = {
        enabled: true,
        revision: options.revision ?? 0,
        delayMs: options.delayMs ?? 0,
        requests: [],
        listReplies: [],
        changes: [],
        fullFallback: false,
        badRemoved: false,
        sessions: summaries,
        add(id, extra = {}) {
            const entry = {
                sessionId: id,
                gameType: "net-test",
                gameKey: `net-test:${id}`,
                status: "completed",
                startTick: 0,
                startWallTime: 0,
                eventCount: 0,
                chunkCount: 0,
                storedBytes: 0,
                ...extra,
            };
            summaries.set(id, entry);
            state.revision++;
            state.changes.push({
                revision: state.revision,
                type: "upsert",
                sessionId: id,
            });
            return entry;
        },
        remove(id) {
            if (!summaries.delete(id)) return false;
            state.revision++;
            state.changes.push({
                revision: state.revision,
                type: "delete",
                sessionId: id,
            });
            return true;
        },
    };
    state.add(sessionId);
    const bytesFor = (id) => traceBytes(id);
    const encodedFor = (id) => encodeBase64(new Uint8Array(bytesFor(id)));
    const status = () => ({
        enabled: state.enabled,
        acceptingSessions: state.enabled,
        count: summaries.size,
        running: [...summaries.values()].filter((entry) => entry.status === "running").length,
        ...(options.legacy ? {} : { revision: state.revision }),
    });
    socket.onmessage = (event) => {
        const request = JSON.parse(event.data);
        state.requests.push(request);
        const send = (payload) =>
            state.delayMs > 0
                ? setTimeout(() => socket.send(JSON.stringify(payload)), state.delayMs)
                : socket.send(JSON.stringify(payload));
        const reply = (result) =>
            send({
                v: TRACE_NET_VERSION,
                kind: "response",
                id: request.id,
                op: request.op,
                ok: true,
                result,
            });
        switch (request.op) {
            case "list": {
                const all = [...summaries.values()];
                if (options.legacy) {
                    const result = { sessions: all };
                    state.listReplies.push(result);
                    return reply(result);
                }
                if (request.since === state.revision) {
                    const result = {
                        unchanged: true,
                        revision: state.revision,
                        store: status(),
                    };
                    state.listReplies.push(result);
                    return reply(result);
                }
                if (
                    request.since === undefined ||
                    request.since > state.revision ||
                    state.fullFallback
                ) {
                    const result = {
                        sessions: all,
                        removed: [],
                        full: true,
                        revision: state.revision,
                        store: status(),
                    };
                    state.listReplies.push(result);
                    return reply(result);
                }
                const latest = new Map();
                for (const change of state.changes) {
                    if (change.revision > request.since) {
                        latest.set(change.sessionId, change.type);
                    }
                }
                const sessions = [];
                const removed = [];
                for (const [id, type] of latest) {
                    if (type === "upsert") {
                        const entry = summaries.get(id);
                        if (entry) sessions.push(entry);
                    } else {
                        removed.push(id);
                    }
                }
                const result = {
                    sessions,
                    removed: state.badRemoved ? "not-an-array" : removed,
                    full: false,
                    revision: state.revision,
                    store: status(),
                };
                state.listReplies.push(result);
                return reply(result);
            }
            case "begin": {
                const encoded = encodedFor(request.sessionId);
                return reply({
                    sessionId: request.sessionId,
                    parts: 1,
                    chars: encoded.length,
                });
            }
            case "part": {
                const encoded = encodedFor(request.sessionId);
                return reply({
                    sessionId: request.sessionId,
                    part: request.part,
                    data: encoded,
                });
            }
            case "delete": {
                state.remove(request.sessionId);
                return reply({ sessionId: request.sessionId, deleted: true });
            }
            case "clear": {
                let removed = 0;
                for (const id of [...summaries.keys()]) {
                    if (state.remove(id)) removed++;
                }
                return reply({ removed });
            }
            case "store":
                state.enabled = request.enabled;
                return reply(status());
            case "status":
                return reply(status());
            default:
                return;
        }
    };
    return { bytes: bytesFor(sessionId), state };
}

async function openPack(bridge, packId, sessionId, packName, options = {}) {
    const socket = new WebSocket(`ws://127.0.0.1:${await listening(bridge)}/`);
    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
    });
    const { bytes, state } = fakeGame(socket, sessionId, options);
    socket.send(
        JSON.stringify({
            v: TRACE_NET_VERSION,
            kind: "ready",
            protocolVersion: 1,
            packId,
            packName,
            store: {
                enabled: true,
                acceptingSessions: true,
                count: state.sessions.size,
                running: 0,
                ...(options.legacy ? {} : { revision: state.revision }),
            },
        })
    );
    return { socket, bytes, state };
}

async function withBridge(run, token) {
    const bridge = new TraceNetBridge(0, "127.0.0.1", token);
    try {
        await run(bridge);
    } finally {
        bridge.close();
    }
}

test("multiple packs connect at once and requests route by source", async () => {
    await withBridge(async (bridge) => {
        const pg = await openPack(bridge, "partygames", "pg-1", "小游戏行为包");
        const ddz = await openPack(bridge, "ddz", "ddz-1", "MCBE Dou Dizhu");
        await waitFor(() => bridge.sources().length === 2);

        expect(bridge.sources().map((entry) => entry.source).sort()).toEqual(["ddz", "partygames"]);

        const sources = await bridge.listAll();
        expect(sources).toHaveLength(2);
        const pgSource = sources.find((entry) => entry.source === "partygames");
        const ddzSource = sources.find((entry) => entry.source === "ddz");
        expect(pgSource.sessions.map((entry) => entry.sessionId)).toEqual(["pg-1"]);
        expect(ddzSource.sessions.map((entry) => entry.sessionId)).toEqual(["ddz-1"]);

        expect((await bridge.download("partygames", "pg-1")).equals(pg.bytes)).toBe(true);
        expect((await bridge.download("ddz", "ddz-1")).equals(ddz.bytes)).toBe(true);

        expect(await bridge.remove("ddz", "ddz-1")).toBe(true);
        expect((await bridge.listAll()).find((entry) => entry.source === "ddz").sessions).toEqual([]);
        // The other pack is unaffected.
        expect((await bridge.listAll()).find((entry) => entry.source === "partygames").sessions).toHaveLength(1);

        expect(await bridge.clear("partygames")).toBe(1);
        expect((await bridge.setStore("partygames", false)).enabled).toBe(false);
        expect((await bridge.status("partygames")).enabled).toBe(false);

        pg.socket.close();
        ddz.socket.close();
    });
});

test("an unchanged poll reuses the cached listing without a status round trip", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ");
        await waitFor(() => bridge.sources().length === 1);

        const first = await bridge.listAll();
        expect(first[0].sessions.map((entry) => entry.sessionId)).toEqual(["ddz-1"]);
        expect(pack.state.requests.map((entry) => entry.op)).toEqual(["list"]);

        const second = await bridge.listAll();
        expect(second[0].sessions).toEqual(first[0].sessions);
        expect(pack.state.requests.map((entry) => entry.op)).toEqual(["list", "list"]);
        expect(pack.state.requests[1].since).toBe(1);

        pack.socket.close();
    });
});

test("a delta reply merges only changed sessions into the cache", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ");
        await waitFor(() => bridge.sources().length === 1);
        await bridge.listAll();

        pack.state.add("ddz-2", { startWallTime: 200 });
        const changed = await bridge.listAll();
        expect(changed[0].sessions.map((entry) => entry.sessionId)).toEqual([
            "ddz-2",
            "ddz-1",
        ]);
        expect(pack.state.requests.at(-1)).toMatchObject({ op: "list", since: 1 });
        expect(pack.state.listReplies.at(-1)).toMatchObject({
            full: false,
            removed: [],
        });
        // Only the changed session crossed the wire.
        expect(pack.state.listReplies.at(-1).sessions).toHaveLength(1);

        pack.socket.close();
    });
});

test("a removed session disappears from the merged cache", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ");
        await waitFor(() => bridge.sources().length === 1);
        await bridge.listAll();

        pack.state.add("ddz-2", { startWallTime: 200 });
        expect((await bridge.listAll())[0].sessions).toHaveLength(2);

        const beforeRemove = pack.state.revision;
        pack.state.remove("ddz-1");
        const after = await bridge.listAll();
        expect(after[0].sessions.map((entry) => entry.sessionId)).toEqual(["ddz-2"]);
        expect(pack.state.requests.at(-1)).toMatchObject({
            op: "list",
            since: beforeRemove,
        });
        expect(pack.state.listReplies.at(-1)).toMatchObject({
            full: false,
            removed: ["ddz-1"],
        });

        pack.socket.close();
    });
});

test("a full reply replaces the cache and sorts by start time", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ");
        await waitFor(() => bridge.sources().length === 1);
        await bridge.listAll();

        pack.state.add("ddz-2", { startWallTime: 300 });
        pack.state.add("ddz-3", { startWallTime: 200 });
        pack.state.fullFallback = true;
        const all = await bridge.listAll();
        expect(all[0].sessions.map((entry) => entry.sessionId)).toEqual([
            "ddz-2",
            "ddz-3",
            "ddz-1",
        ]);
        expect(pack.state.listReplies.at(-1).full).toBe(true);

        pack.socket.close();
    });
});

test("an invalid delta is reported as a source error without corrupting the cache", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ");
        await waitFor(() => bridge.sources().length === 1);
        await bridge.listAll();

        pack.state.add("ddz-2");
        pack.state.badRemoved = true;
        const bad = await bridge.listAll();
        expect(bad[0].error).toContain("removed");
        expect(bad[0].sessions).toEqual([]);

        // The rejected delta never reached the cache.
        pack.state.badRemoved = false;
        const recovered = await bridge.listAll();
        expect(recovered[0].sessions.map((entry) => entry.sessionId).sort()).toEqual([
            "ddz-1",
            "ddz-2",
        ]);

        pack.socket.close();
    });
});

test("legacy packs without a full field replace the cache", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ", { legacy: true });
        await waitFor(() => bridge.sources().length === 1);
        await bridge.listAll();

        pack.state.remove("ddz-1");
        pack.state.add("ddz-2");
        const after = await bridge.listAll();
        expect(after[0].sessions.map((entry) => entry.sessionId)).toEqual(["ddz-2"]);

        pack.socket.close();
    });
});

test("legacy packs without revisions fall back to a status request", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ", { legacy: true });
        await waitFor(() => bridge.sources().length === 1);

        const first = await bridge.listAll();
        expect(first[0].sessions.map((entry) => entry.sessionId)).toEqual(["ddz-1"]);
        expect(first[0].store).toMatchObject({ enabled: true, count: 1 });
        expect(pack.state.requests.map((entry) => entry.op)).toEqual(["list", "status"]);

        // No revision is available, so every poll remains a full legacy poll.
        await bridge.listAll();
        expect(pack.state.requests.map((entry) => entry.op)).toEqual([
            "list",
            "status",
            "list",
            "status",
        ]);
        expect(pack.state.requests.filter((entry) => entry.op === "list").every(
            (entry) => !("since" in entry)
        )).toBe(true);

        pack.socket.close();
    });
});

test("concurrent pollers share one in-flight list request", async () => {
    await withBridge(async (bridge) => {
        const pack = await openPack(bridge, "ddz", "ddz-1", "DDZ", { delayMs: 30 });
        await waitFor(() => bridge.sources().length === 1);

        const [a, b] = await Promise.all([bridge.listAll(), bridge.listAll()]);
        expect(a[0].sessions.map((entry) => entry.sessionId)).toEqual(["ddz-1"]);
        expect(b[0].sessions.map((entry) => entry.sessionId)).toEqual(["ddz-1"]);
        expect(pack.state.requests.filter((entry) => entry.op === "list")).toHaveLength(1);

        // The finished request populated the cache, so the next pair is one
        // tiny unchanged poll rather than another full transfer.
        await Promise.all([bridge.listAll(), bridge.listAll()]);
        const lists = pack.state.requests.filter((entry) => entry.op === "list");
        expect(lists).toHaveLength(2);
        expect(lists[1].since).toBe(1);

        pack.socket.close();
    });
});

test("a reconnecting pack starts from a fresh cache", async () => {
    await withBridge(async (bridge) => {
        const first = await openPack(bridge, "ddz", "old-session", "DDZ");
        await waitFor(() => bridge.sources().length === 1);
        await bridge.listAll();
        expect(first.state.requests).toHaveLength(1);

        first.socket.close();
        await waitFor(() => bridge.sources().length === 0);

        // The reloaded pack starts at the same revision 1. If the cache were
        // kept, this poll would be mistaken for `unchanged` and list the old
        // session instead of the new one.
        const second = await openPack(bridge, "ddz", "new-session", "DDZ");
        await waitFor(() => bridge.sources().length === 1);
        const sessions = await bridge.listAll();
        expect(sessions[0].sessions.map((entry) => entry.sessionId)).toEqual([
            "new-session",
        ]);
        expect(second.state.requests[0].op).toBe("list");
        expect("since" in second.state.requests[0]).toBe(false);

        second.socket.close();
    });
});

test("a reconnecting pack replaces its stale socket", async () => {
    await withBridge(async (bridge) => {
        const first = await openPack(bridge, "ddz", "ddz-1", "DDZ");
        await waitFor(() => bridge.sources().length === 1);
        const second = await openPack(bridge, "ddz", "ddz-2", "DDZ");

        // The second handshake replaces the first socket, so keep polling until
        // the new session id is the one being served.
        let sessions = [];
        for (let attempt = 0; attempt < 100; attempt++) {
            const list = await bridge.listAll();
            sessions = list[0]?.sessions.map((entry) => entry.sessionId) ?? [];
            if (sessions.includes("ddz-2")) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(bridge.sources()).toHaveLength(1);
        expect(sessions).toEqual(["ddz-2"]);
        first.socket.close();
        second.socket.close();
    });
});

test("unknown sources fail cleanly", async () => {
    await withBridge(async (bridge) => {
        expect(await bridge.listAll()).toEqual([]);
        await expect(bridge.download("nope", "x")).rejects.toThrow("数据源未连接");
    });
});

test("a token-protected bridge refuses a client without the token", async () => {
    await withBridge(async (bridge) => {
        const socket = new WebSocket(`ws://127.0.0.1:${await listening(bridge)}/`);
        const outcome = await new Promise((resolve) => {
            socket.onopen = () => resolve("open");
            socket.onerror = () => resolve("error");
            socket.onclose = () => resolve("close");
            setTimeout(() => resolve("timeout"), 2000);
        });
        expect(outcome).not.toBe("open");
        expect(bridge.connected).toBe(false);
    }, "secret");
});
