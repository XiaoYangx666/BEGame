import { expect, test } from "vitest";
import { decodeBegTrace, TraceManager } from "../packages/trace/dist/index.js";

/**
 * A long-running session must be archived incrementally: each sealed chunk is
 * handed to the store while the session is still running, so a crash or a
 * restart loses at most the active chunk instead of the whole session.
 */
test("a long-running session appends chunks incrementally before it ends", () => {
    let tick = 1;
    const manager = new TraceManager(() => tick, { maxChunkTickSpan: 5, maxChunkBytes: 128 });
    manager.store.enable();
    const session = manager.beginSession({ gameType: "long", gameKey: "long:1" });
    expect(session).toBeDefined();
    const sessionId = session.header.sessionId;

    for (let index = 0; index < 10; index++) session.game.debug("early-" + index);
    const early = manager.store.list().find((entry) => entry.sessionId === sessionId);
    expect(early.status).toBe("running");
    expect(early.chunkCount).toBeGreaterThan(0);

    for (let index = 0; index < 30; index++) { tick += 1; session.game.debug("late-" + index); }
    const grown = manager.store.list().find((entry) => entry.sessionId === sessionId);
    expect(grown.status).toBe("running");
    expect(grown.chunkCount).toBeGreaterThan(early.chunkCount);

    // The live snapshot seals and includes the active chunk without ending the session.
    const snapshot = decodeBegTrace(manager.snapshotBytes(sessionId));
    expect(snapshot.end.endReason).toBe("live-snapshot");
    expect(snapshot.end.status).toBe("interrupted");
    expect(snapshot.events.length).toBeGreaterThan(30);
    expect(manager.store.list().find((entry) => entry.sessionId === sessionId).status).toBe("running");

    session.end("completed", "done", tick);
    const completed = decodeBegTrace(manager.store.toBytes(sessionId));
    expect(completed.end.status).toBe("completed");
    expect(completed.events.length).toBeGreaterThan(30);
});

test("a running session is never evicted by retention cleanup", () => {
    let tick = 1;
    const manager = new TraceManager(() => tick, {
        maxChunkTickSpan: 5,
        storeOptions: { maxSessions: 1, maxBytes: 1, maxAgeMs: 1 },
    });
    manager.store.enable();
    const running = manager.beginSession({ gameType: "long", gameKey: "long:running" });
    for (let index = 0; index < 10; index++) { tick += 1; running.game.debug("e" + index); }

    const removed = manager.store.cleanup();
    expect(removed).not.toContain(running.header.sessionId);
    expect(manager.store.list().some((entry) => entry.sessionId === running.header.sessionId)).toBe(true);

    running.end("completed", "done", tick);
});
