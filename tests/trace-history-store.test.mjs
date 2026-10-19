import { expect, test } from "vitest";
import {
    TraceHistoryStore,
    decodeBegTraceContainer,
} from "../packages/trace/dist/index.js";

/**
 * These drive the history store directly through its TraceSink contract, with
 * fake storage seams and no Minecraft runtime at all. That is the point of the
 * abstraction: retention, reload recovery and the "an accepted session finishes
 * atomically" invariant are pure bookkeeping and belong in unit tests, not only
 * in an end-to-end run through the virtual world.
 */
function testStorage({ ready = true } = {}) {
    const values = new Map();
    const waiters = new Set();
    const timers = new Map();
    let isReady = ready;
    let nextTimer = 1;

    return {
        values,
        timers,
        storage: {
            kv: {
                set(key, value) {
                    if (value === undefined) values.delete(key);
                    else values.set(key, value);
                },
                get: (key) => values.get(key),
                keys: () => [...values.keys()],
            },
            scheduler: {
                every(ticks, callback) {
                    const handle = nextTimer++;
                    timers.set(handle, { ticks, callback });
                    return handle;
                },
                cancel(handle) {
                    timers.delete(handle);
                },
            },
            gate: {
                isReady: () => isReady,
                afterReady(callback) {
                    if (isReady) {
                        callback();
                        return () => undefined;
                    }
                    waiters.add(callback);
                    return () => waiters.delete(callback);
                },
            },
        },
        becomeReady() {
            isReady = true;
            for (const callback of [...waiters]) {
                waiters.delete(callback);
                callback();
            }
        },
    };
}

function header(sessionId, overrides = {}) {
    return {
        sessionId,
        formatVersion: 1,
        gameType: "history-store-test",
        gameKey: `${sessionId}:0`,
        gameInstanceId: sessionId,
        startTick: 0,
        startWallTime: Date.now(),
        ...overrides,
    };
}

function chunk(sessionId, index) {
    return {
        sessionId,
        index,
        firstSequence: index * 10,
        lastSequence: index * 10 + 9,
        startTick: index * 10,
        endTick: index * 10 + 10,
        eventCount: 10,
        bytes: new Uint8Array([1, 2, 3, index]),
    };
}

function end(sessionId, overrides = {}) {
    return {
        sessionId,
        status: "completed",
        endTick: 30,
        endWallTime: Date.now(),
        endReason: "test",
        eventCount: 10,
        chunkCount: 1,
        ...overrides,
    };
}

/** Writes one complete session the way TraceManager would. */
function writeSession(store, sessionId, { header: headerOverrides, end: endOverrides } = {}) {
    store.onSessionStart(header(sessionId, headerOverrides));
    store.onChunk(chunk(sessionId, 0));
    store.onSessionEnd(end(sessionId, endOverrides));
}

test("records, reads back and re-encodes a session without Minecraft", () => {
    const { storage } = testStorage();
    const store = new TraceHistoryStore(storage).enable();

    writeSession(store, "s1");

    const summaries = store.list();
    expect(summaries.map((entry) => entry.sessionId)).toEqual(["s1"]);
    expect(summaries[0]).toMatchObject({
        status: "completed",
        gameType: "history-store-test",
        chunkCount: 1,
        eventCount: 10,
    });

    // Chunk bytes must survive the Base64 round trip the storage layer forces.
    const stored = store.read("s1");
    expect([...stored.chunks[0]]).toEqual([1, 2, 3, 0]);

    // And the persisted history must re-encode into a decodable container.
    const container = decodeBegTraceContainer(store.toBytes("s1"));
    expect(container.header.sessionId).toBe("s1");
    expect(container.end.status).toBe("completed");
});

test("enforces the session-count retention limit", () => {
    const { storage } = testStorage();
    const store = new TraceHistoryStore(storage, { maxSessions: 1 }).enable();

    // list() orders by startWallTime, and the age rule must not fire first, so
    // both timestamps are recent and distinct.
    const now = Date.now();
    writeSession(store, "old", {
        header: { startWallTime: now - 2_000 },
        end: { endWallTime: now - 2_000 },
    });
    writeSession(store, "new", {
        header: { startWallTime: now - 1_000 },
        end: { endWallTime: now - 1_000 },
    });

    expect(store.list().map((entry) => entry.sessionId)).toEqual(["new"]);
});

test("enforces the age retention limit", () => {
    const { storage } = testStorage();
    const store = new TraceHistoryStore(storage, { maxAgeMs: 1_000 }).enable();

    writeSession(store, "ancient", { end: { endWallTime: 0 } });

    expect(store.list()).toHaveLength(0);
});

test("an accepted session finishes even after storage is disabled", () => {
    const { storage } = testStorage();
    const store = new TraceHistoryStore(storage).enable();

    store.onSessionStart(header("accepted"));
    store.disable();
    // New sessions are refused from here on...
    store.onSessionStart(header("rejected"));
    // ...but the one already accepted must still be committed in full.
    store.onChunk(chunk("accepted", 0));
    store.onSessionEnd(end("accepted"));

    expect(store.list().map((entry) => entry.sessionId)).toEqual(["accepted"]);
});

test("refuses sessions until the storage gate reports ready", () => {
    const harness = testStorage({ ready: false });
    const store = new TraceHistoryStore(harness.storage).enable();

    expect(store.acceptingSessions).toBe(false);
    store.onSessionStart(header("too-early"));
    expect(store.list()).toHaveLength(0);

    harness.becomeReady();

    expect(store.acceptingSessions).toBe(true);
    store.onSessionStart(header("in-time"));
    expect(store.list().map((entry) => entry.sessionId)).toEqual(["in-time"]);
});

test("recovers a session left running by a previous runtime", () => {
    const harness = testStorage();
    const before = new TraceHistoryStore(harness.storage).enable();
    before.onSessionStart(header("crashed"));
    before.onChunk(chunk("crashed", 0));
    // No footer: this is what a script reload leaves behind.

    const after = new TraceHistoryStore(harness.storage).enable();

    expect(after.list()[0]).toMatchObject({
        sessionId: "crashed",
        status: "interrupted",
        endReason: "runtime-recovered",
    });
});

test("restoreEnabled defaults to disabled when nothing was persisted", () => {
    const harness = testStorage();
    const store = new TraceHistoryStore(harness.storage);

    expect(store.enabled).toBe(false);
    store.restoreEnabled();
    expect(store.enabled).toBe(false);

    store.onSessionStart(header("nope"));
    expect(store.list()).toHaveLength(0);
});

test("enable/disable persist the flag and restoreEnabled re-applies it", () => {
    const harness = testStorage();
    const first = new TraceHistoryStore(harness.storage).enable();
    expect(harness.values.get("begame.trace.v1.enabled")).toBe(true);

    const reopened = new TraceHistoryStore(harness.storage);
    reopened.restoreEnabled();
    expect(reopened.enabled).toBe(true);
    reopened.onSessionStart(header("kept"));
    expect(reopened.list().map((entry) => entry.sessionId)).toEqual(["kept"]);

    reopened.disable();
    expect(harness.values.get("begame.trace.v1.enabled")).toBe(false);

    const after = new TraceHistoryStore(harness.storage);
    after.restoreEnabled();
    expect(after.enabled).toBe(false);
});

test("persisting the flag waits for the storage gate", () => {
    const harness = testStorage({ ready: false });
    const store = new TraceHistoryStore(harness.storage).enable();

    expect(harness.values.has("begame.trace.v1.enabled")).toBe(false);
    harness.becomeReady();
    expect(harness.values.get("begame.trace.v1.enabled")).toBe(true);
});

test("drives maintenance through the injected scheduler", () => {
    const harness = testStorage();
    const store = new TraceHistoryStore(harness.storage).enable();

    expect(harness.timers.size).toBe(1);
    harness.timers.values().next().value.callback();

    store.disable();
    expect(harness.timers.size).toBe(0);
});

test("list() reuses one snapshot until a store write invalidates it", () => {
    const { storage } = testStorage();
    const store = new TraceHistoryStore(storage).enable();
    writeSession(store, "s1");

    let keyReads = 0;
    let valueReads = 0;
    const keys = storage.kv.keys;
    const get = storage.kv.get;
    storage.kv.keys = () => {
        keyReads++;
        return keys();
    };
    storage.kv.get = (key) => {
        valueReads++;
        return get(key);
    };

    // Warm the snapshot, then prove repeated polls do not touch the substrate.
    const first = store.list();
    keyReads = 0;
    valueReads = 0;
    expect(store.list()).toEqual(first);
    expect(store.list()).toEqual(first);
    expect(keyReads).toBe(0);
    expect(valueReads).toBe(0);

    // A session write invalidates exactly once; the next poll rebuilds.
    store.onSessionStart(header("s2"));
    keyReads = 0;
    valueReads = 0;
    expect(store.list().map((entry) => entry.sessionId)).toEqual(["s2", "s1"]);
    expect(keyReads).toBe(1);
    expect(valueReads).toBe(2);

    // A delete invalidates too.
    expect(store.delete("s1")).toBe(true);
    keyReads = 0;
    valueReads = 0;
    expect(store.list().map((entry) => entry.sessionId)).toEqual(["s2"]);
    expect(keyReads).toBe(1);
    expect(valueReads).toBe(1);

    // Cached snapshots are independent arrays, not aliases of the cache.
    expect(first.map((entry) => entry.sessionId)).toEqual(["s1"]);
});
