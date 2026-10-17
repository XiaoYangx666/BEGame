import { expect, test } from "vitest";
import {
    TraceSession,
    TraceHistoryStore,
    defineTraceEvent,
} from "../packages/trace/dist/index.js";

function header(id) {
    return {
        sessionId: id, gameType: "replay-fixture", gameKey: id,
        gameInstanceId: id, startTick: 0, startWallTime: Date.now(),
        formatVersion: 1,
    };
}

test("custom Trace emission reports buffer acceptance without changing best-effort semantics", () => {
    const failures = [], emitted = [];
    const session = new TraceSession(header("ack"), () => 0, {
        onChunk: chunk => emitted.push(chunk),
    }, { onInternalError: error => failures.push(error) });
    const event = defineTraceEvent("test.replay.record", { step: "uint" });
    expect(session.game.emit(event, { step: 4 })).toBe(true);
    // An invalid payload must not be falsely acknowledged.
    expect(session.game.emit(event, {})).toBe(false);
    expect(failures).toHaveLength(1);
    expect(session.eventCount).toBe(1);
    session.end("completed");
    expect(session.game.emit(event, { step: 5 })).toBe(false);
    expect(emitted).toHaveLength(1);
});

function storageWithFailure() {
    const values = new Map();
    let throwChunks = true;
    return {
        values,
        storage: {
            kv: {
                set(key, value) {
                    if (throwChunks && key.endsWith(".0")) throw Error("simulated DP write failure");
                    if (value === undefined) values.delete(key);
                    else values.set(key, value);
                },
                get: key => values.get(key),
                keys: () => [...values.keys()],
            },
            gate: { isReady: () => true, afterReady: fn => { fn(); return () => {}; } },
            scheduler: { every: () => 1, cancel: () => {} },
        },
        stopFailing: () => { throwChunks = false; },
    };
}

test("failed chunk storage must not publish a complete replayable history", () => {
    const { storage } = storageWithFailure();
    const failures = [];
    const store = new TraceHistoryStore(storage, {}, error => failures.push(error)).enable();
    store.onSessionStart(header("lost"));
    expect(() => store.onChunk({
        sessionId: "lost", index: 0, firstSequence: 1, lastSequence: 1,
        startTick: 0, endTick: 0, eventCount: 1, bytes: new Uint8Array([1, 2, 3]),
    })).toThrow("simulated DP write failure");
    store.onSessionEnd({
        sessionId: "lost", status: "completed", endTick: 0,
        endWallTime: 2, eventCount: 1, chunkCount: 1,
    });
    expect(store.list()[0]).toMatchObject({ status: "interrupted", chunkCount: 0, eventCount: 0 });
    expect(store.read("lost")).toBeUndefined();
    expect(() => store.toBytes("lost")).toThrow(/not complete/i);
    expect(failures.some(e => /Incomplete Trace storage/.test(e.message))).toBe(true);
});

test("footer count disagreement invalidates a recording even if all chunk writes succeeded", () => {
    const values = new Map();
    const store = new TraceHistoryStore({
        kv: {
            get: key => values.get(key),
            set: (key, value) => value === undefined ? values.delete(key) : values.set(key, value),
            keys: () => [...values.keys()],
        },
        scheduler: { every: () => 1, cancel: () => {} },
        gate: { isReady: () => true, afterReady: fn => { fn(); return () => {}; } },
    }).enable();
    store.onSessionStart(header("count-mismatch"));
    store.onSessionEnd({
        sessionId: "count-mismatch", status: "completed", endTick: 1,
        endWallTime: 2, eventCount: 10, chunkCount: 1,
    });
    expect(store.list()[0].status).toBe("interrupted");
    expect(() => store.toBytes("count-mismatch")).toThrow();
});
