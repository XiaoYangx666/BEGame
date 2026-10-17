import { expect, test } from "vitest";
import { encodeBase64, encodeBegTrace } from "../packages/trace/dist/index.js";
import {
    buildContext,
    decodeTracePayload,
    looksLikeBegTrace,
} from "../packages/observatory/src/decode.mjs";

function makeTraceBytes(sessionId, options = {}) {
    const header = {
        sessionId,
        formatVersion: 1,
        gameType: options.gameType ?? "observatory-test",
        gameKey: `${options.gameType ?? "observatory-test"}:0`,
        gameInstanceId: sessionId,
        startTick: 100,
        startWallTime: 1000,
    };
    const end = {
        sessionId,
        status: "completed",
        endTick: 350,
        endWallTime: 3500,
        endReason: options.endReason ?? "test",
        eventCount: 0,
        chunkCount: 0,
    };
    return encodeBegTrace(header, [], end);
}

function logFor(bytes, sessionId) {
    const base64 = encodeBase64(bytes);
    const cut = Math.floor(base64.length / 2);
    return (
        "[Localization][warning]-unrelated\n" +
        `[Scripting][warning]-[BEGAME_TRACE:v1:${sessionId}:1/2]${base64.slice(0, cut)}\n` +
        "[Sound][inform]-still unrelated\n" +
        `[Scripting][warning]-[BEGAME_TRACE:v1:${sessionId}:2/2]${base64.slice(cut)}\n`
    );
}

const encoder = new TextEncoder();

test("observatory decodes a Content Log export and strips base64 from metadata", () => {
    const bytes = makeTraceBytes("observatory-1");
    const result = decodeTracePayload(encoder.encode(logFor(bytes, "observatory-1")));

    expect(result.ok).toBe(true);
    expect(result.source).toBe("log");
    expect(result.selected.sessionId).toBe("observatory-1");
    expect(result.selected.header.gameType).toBe("observatory-test");
    expect(result.selected.end.status).toBe("completed");
    expect(result.selected.events).toEqual([]);
    expect(result.selected.stats.tickSpan).toBe(250);
    expect(result.selected.stats.wallSpanMs).toBe(2500);
    expect(result.exports).toHaveLength(1);
    expect(result.exports[0].complete).toBe(true);
    expect(result.exports[0].base64).toBeUndefined();
});

test("observatory reports incomplete multipart exports with missing parts", () => {
    const result = decodeTracePayload(
        encoder.encode("[Scripting][warning]-[BEGAME_TRACE:v1:observatory-missing:1/2]QUJD\n")
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/缺少分片/);
    expect(result.exports[0].missingParts).toEqual([2]);
});

test("observatory decodes raw .begtrace bytes", () => {
    const bytes = makeTraceBytes("observatory-raw");
    expect(looksLikeBegTrace(bytes)).toBe(true);

    const result = decodeTracePayload(bytes);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("begtrace");
    expect(result.selected.sessionId).toBe("observatory-raw");
});

test("observatory handles Uint8Array views with a non-zero byte offset", () => {
    const bytes = makeTraceBytes("observatory-offset");
    const view = Buffer.concat([Buffer.alloc(8, 0xff), bytes]).subarray(8);
    expect(view.byteOffset).toBeGreaterThan(0);

    const result = decodeTracePayload(view);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("begtrace");
    expect(result.selected.sessionId).toBe("observatory-offset");
});

test("observatory selects the requested session and defaults to the latest complete one", () => {
    const first = makeTraceBytes("observatory-old", { gameType: "old" });
    const second = makeTraceBytes("observatory-new", { gameType: "new" });
    const log = logFor(first, "observatory-old") + logFor(second, "observatory-new");
    const bytes = encoder.encode(log);

    const latest = decodeTracePayload(bytes);
    expect(latest.selected.sessionId).toBe("observatory-new");

    const requested = decodeTracePayload(bytes, "observatory-old");
    expect(requested.selected.sessionId).toBe("observatory-old");
    expect(requested.selected.header.gameType).toBe("old");

    const missing = decodeTracePayload(bytes, "observatory-none");
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/未找到/);
});

function event(sequence, tick, type, source, payload = {}) {
    return { sequence, tick, typeId: 0, type, source, payload };
}

test("observatory context builds the state tree, owners and player/seat registries", () => {
    const header = {
        sessionId: "context-test",
        formatVersion: 1,
        gameType: "context",
        gameKey: "context:0",
        gameInstanceId: "context-test",
        startTick: 0,
        startWallTime: 0,
    };
    const end = {
        sessionId: "context-test",
        status: "completed",
        endTick: 100,
        endWallTime: 1000,
        endReason: "test",
        eventCount: 15,
        chunkCount: 1,
    };
    const events = [
        event(1, 0, "game.created", { kind: "game" }, { gameType: "context" }),
        event(2, 0, "state.push", { kind: "state", ref: 0, name: "RootState" }, { depth: 0, state: "RootState" }),
        event(3, 0, "component.attach_started", { kind: "component", ref: 5, name: "Alpha" }, { component: "Alpha" }),
        event(4, 0, "component.attached", { kind: "component", ref: 5, name: "Alpha" }, { component: "Alpha" }),
        event(5, 0, "component.attach_failed", { kind: "component", ref: 6, name: "Beta" }, { component: "Beta" }),
        event(6, 0, "state.enter", { kind: "state", ref: 0, name: "RootState" }, { depth: 0 }),
        event(7, 1, "state.push", { kind: "state", ref: 1, name: "ChildState" }, { depth: 1, state: "ChildState" }),
        event(8, 1, "dou.seat.changed", { kind: "state", ref: 1, name: "ChildState" }, { seat: 1, kind: "bot", participantId: "bot-1", name: "P1" }),
        event(9, 2, "state.enter", { kind: "state", ref: 1, name: "ChildState" }, { depth: 1 }),
        event(10, 30, "state.exit", { kind: "state", ref: 1, name: "ChildState" }, { reason: "replace" }),
        event(11, 30, "state.remove", { kind: "state", ref: 1, name: "ChildState" }, { reason: "replace", success: true }),
        event(12, 31, "participation.joined", { kind: "participation" }, { player: "bot-1" }),
        event(13, 99, "state.exit", { kind: "state", ref: 0, name: "RootState" }, { reason: "dispose" }),
        event(14, 99, "state.remove", { kind: "state", ref: 0, name: "RootState" }, { reason: "dispose", success: true }),
        event(15, 100, "game.disposed", { kind: "game" }, { success: true }),
    ];

    const context = buildContext({ header, end, events });
    const byKey = new Map(context.nodes.map((node) => [node.key, node]));

    expect(context.nodes).toHaveLength(3);
    expect(byKey.get("session").children).toEqual(["state:0"]);
    expect(byKey.get("state:0").parentKey).toBe("session");
    expect(byKey.get("state:1").parentKey).toBe("state:0");
    expect(byKey.get("state:1").exitTick).toBe(30);
    expect(byKey.get("state:0").exitTick).toBe(99);

    expect(context.eventOwners[2]).toBe("state:0");
    expect(context.eventOwners[7]).toBe("state:1");
    expect(context.eventOwners[11]).toBe("state:0");
    expect(context.eventOwners[14]).toBe("session");

    expect(context.players).toEqual([
        {
            id: "bot-1",
            name: "P1",
            seats: [1],
            firstSequence: 8,
            lastSequence: 12,
        },
    ]);
    expect(context.seats[0]).toMatchObject({
        seat: 1,
        name: "P1",
        kind: "bot",
        participantId: "bot-1",
    });
    expect(context.seats[0].changes).toHaveLength(1);

    expect(context.errors).toEqual([
        { eventIndex: 4, nodeKey: "state:0", type: "component.attach_failed" },
    ]);
});

test("observatory treats namespaced rejected events as diagnostic signals", () => {
    const header = {
        sessionId: "diagnostic-test",
        formatVersion: 1,
        gameType: "diagnostic",
        gameKey: "diagnostic:0",
        gameInstanceId: "diagnostic-test",
        startTick: 0,
        startWallTime: 0,
    };
    const end = {
        sessionId: "diagnostic-test",
        status: "completed",
        endTick: 1,
        endWallTime: 50,
        eventCount: 1,
        chunkCount: 1,
    };
    const events = [
        event(1, 1, "game.transition.rejected", { kind: "game" }, { reason: "invalid" }),
    ];

    expect(buildContext({ header, end, events }).errors).toEqual([
        { eventIndex: 0, nodeKey: "session", type: "game.transition.rejected" },
    ]);
});

test("observatory identifies players and named seats from generic Tabletop events", () => {
    const header = {
        sessionId: "named-seats", formatVersion: 1, gameType: "xiangqi",
        gameKey: "xiangqi:1", gameInstanceId: "named-seats",
        startTick: 0, startWallTime: 0,
    };
    const end = {
        sessionId: "named-seats", status: "completed", endTick: 30,
        endWallTime: 1500, eventCount: 8, chunkCount: 1,
    };
    const events = [
        event(1, 1, "tabletop.stage.changed", { kind: "game" }, { stage: "lobby", revision: 0 }),
        event(2, 2, "tabletop.seat.changed", { kind: "game" }, { seat: "red", kind: "empty", revision: 0 }),
        event(3, 2, "tabletop.seat.changed", { kind: "game" }, { seat: "black", kind: "empty", revision: 0 }),
        event(4, 3, "tabletop.member.changed", { kind: "game" }, { player: "alice", status: "joined", revision: 1 }),
        event(5, 4, "tabletop.seat.changed", { kind: "game" }, { seat: "red", kind: "human", participantId: "alice", name: "Alice", revision: 1 }),
        event(6, 5, "tabletop.seat.changed", { kind: "game" }, { seat: "black", kind: "bot", revision: 2 }),
        event(7, 6, "tabletop.seat.changed", { kind: "game" }, { seat: "red", kind: "empty", revision: 3 }),
        event(8, 7, "tabletop.member.changed", { kind: "game" }, { player: "alice", status: "left", revision: 3 }),
    ];
    const context = buildContext({ header, end, events });
    expect(context.players).toHaveLength(1);
    expect(context.players[0].id).toBe("alice");
    expect(context.players[0].name).toBe("Alice");
    expect(context.players[0].seats).toEqual(["red"]);
    expect(context.seats.map(s => s.seat)).toEqual(["black", "red"]);
    const red = context.seats.find(s => s.seat === "red");
    expect(red.kind).toBe("empty");
    expect(red.name).toBeUndefined();
    expect(red.participantId).toBeUndefined();
    expect(red.changes).toHaveLength(3);
    const black = context.seats.find(s => s.seat === "black");
    expect(black.kind).toBe("bot");
    expect(black.participantId).toBeUndefined();
    expect(context.eventOwners).toEqual(Array(8).fill("session"));
    expect(context.nodes).toHaveLength(1);
});

test("observatory preserves numbered seats and clears old occupant on seat reset", () => {
    const header = { startTick: 0 };
    const end = { endTick: 5, eventCount: 3 };
    const events = [
        event(1, 1, "doudizhu.seat.changed", { kind: "game" }, { seat: 2, kind: "human", participantId: "alice", name: "Alice" }),
        event(2, 2, "doudizhu.seat.changed", { kind: "game" }, { seat: 2, kind: "empty" }),
        event(3, 3, "doudizhu.seat.changed", { kind: "game" }, { seat: 10, kind: "bot" }),
    ];
    const context = buildContext({ header, end, events });
    expect(context.seats.map(s => s.seat)).toEqual([2, 10]);
    expect(context.seats[0].participantId).toBeUndefined();
    expect(context.seats[0].name).toBeUndefined();
});
