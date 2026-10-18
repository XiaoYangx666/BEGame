import { beforeEach, expect, test } from "vitest";
import { system } from "@minecraft/server";
import { decodeBegTrace, TraceManager } from "../packages/trace/dist/index.js";
import { createServerNetTraceBridge } from "../packages/trace/dist/serverNet.js";
import {
    connectFailures,
    connectionAttempts,
    resetServerNet,
    sockets,
} from "./fakes/serverNet.mjs";

const URL = "ws://127.0.0.1:18790/";

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeTrace() {
    let tick = 1;
    const trace = new TraceManager(() => tick++);
    trace.store.enable();
    const session = trace.beginSession({ gameType: "probe", gameKey: "probe:1" });
    session.game.debug("bridge-test");
    trace.endSession("probe:1", "completed");
    return { trace, sessionId: session.header.sessionId };
}

async function connectedBridge() {
    const { trace, sessionId } = makeTrace();
    const bridge = createServerNetTraceBridge({ url: URL, trace, packId: "probe", packName: "probe" });
    bridge.start();
    await flush();
    const socket = sockets.at(-1);
    expect(socket).toBeDefined();
    return { bridge, socket, sessionId };
}

function request(socket, value) {
    socket.receive(JSON.stringify(value));
    return socket.replies().at(-1);
}

beforeEach(() => {
    resetServerNet();
    system.resetScriptResources();
    system.resetClock();
});

test("connecting sends a ready handshake with store status", async () => {
    const { bridge, socket } = await connectedBridge();
    const ready = socket.replies()[0];
    expect(ready.kind).toBe("ready");
    expect(ready.packId).toBe("probe");
    expect(ready.packName).toBe("probe");
    expect(ready.store.count).toBe(1);
    expect(connectionAttempts[0].uri).toBe(URL);
    bridge.stop();
});

test("list returns stored sessions", async () => {
    const { bridge, socket, sessionId } = await connectedBridge();
    const reply = request(socket, { v: 1, kind: "request", id: "1", op: "list" });
    expect(reply.ok).toBe(true);
    expect(reply.result.sessions.map((entry) => entry.sessionId)).toEqual([sessionId]);
    bridge.stop();
});

test("begin/part streams a decodable container", async () => {
    const { bridge, socket, sessionId } = await connectedBridge();
    const begin = request(socket, { v: 1, kind: "request", id: "1", op: "begin", sessionId });
    expect(begin.ok).toBe(true);
    expect(begin.result.parts).toBe(1);

    let base64 = "";
    for (let part = 0; part < begin.result.parts; part++) {
        const reply = request(socket, {
            v: 1,
            kind: "request",
            id: `p${part}`,
            op: "part",
            sessionId,
            part,
        });
        expect(reply.ok).toBe(true);
        base64 += reply.result.data;
    }
    expect(decodeBegTrace(Buffer.from(base64, "base64")).header.sessionId).toBe(sessionId);
    bridge.stop();
});

test("a part request before begin fails cleanly", async () => {
    const { bridge, socket, sessionId } = await connectedBridge();
    const reply = request(socket, {
        v: 1,
        kind: "request",
        id: "1",
        op: "part",
        sessionId,
        part: 0,
    });
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("request_info_first");
    bridge.stop();
});

test("delete removes a stored session", async () => {
    const { bridge, socket, sessionId } = await connectedBridge();
    const reply = request(socket, { v: 1, kind: "request", id: "1", op: "delete", sessionId });
    expect(reply.result).toEqual({ sessionId, deleted: true });

    const list = request(socket, { v: 1, kind: "request", id: "2", op: "list" });
    expect(list.result.sessions).toEqual([]);
    bridge.stop();
});

test("a connect failure is reported and retried", async () => {
    const { trace } = makeTrace();
    const errors = [];
    connectFailures.push(new Error("network down"));
    const bridge = createServerNetTraceBridge({
        url: URL,
        trace,
        packId: "probe",
        onError: (error) => errors.push(error),
    });
    bridge.start();
    await flush();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("network down");
    bridge.stop();
});

test("failed connects back off and pause at the failure cap", async () => {
    const { trace } = makeTrace();
    const errors = [];
    connectFailures.push(new Error("down 1"), new Error("down 2"), new Error("down 3"));
    const bridge = createServerNetTraceBridge({
        url: URL,
        trace,
        packId: "probe",
        reconnectTicks: 10,
        maxReconnectTicks: 40,
        maxConsecutiveFailures: 3,
        onError: (error) => errors.push(error),
    });
    bridge.start();
    await flush();
    expect(connectionAttempts).toHaveLength(1);
    expect(bridge.suspended).toBe(false);

    await system.advanceTicks(10); // first retry uses the base delay
    await flush();
    expect(connectionAttempts).toHaveLength(2);

    await system.advanceTicks(20); // second retry doubles to 20 ticks
    await flush();
    expect(connectionAttempts).toHaveLength(3);
    expect(bridge.suspended).toBe(true);

    await system.advanceTicks(10_000); // paused: no further connect attempts
    await flush();
    expect(connectionAttempts).toHaveLength(3);
    expect(errors).toHaveLength(2);
    expect(String(errors[1])).toContain("paused");
    bridge.stop();
});

test("start() resumes a bridge that paused after failures", async () => {
    const { trace } = makeTrace();
    connectFailures.push(new Error("down"));
    const bridge = createServerNetTraceBridge({
        url: URL,
        trace,
        packId: "probe",
        reconnectTicks: 10,
        maxConsecutiveFailures: 1,
        onError: () => undefined,
    });
    bridge.start();
    await flush();
    expect(bridge.suspended).toBe(true);
    expect(bridge.connected).toBe(false);

    bridge.start();
    await flush();
    expect(bridge.suspended).toBe(false);
    expect(bridge.connected).toBe(true);
    bridge.stop();
});

test("store toggling is reflected in status", async () => {
    const { bridge, socket, sessionId } = await connectedBridge();
    const off = request(socket, { v: 1, kind: "request", id: "1", op: "store", enabled: false });
    expect(off.result.enabled).toBe(false);
    const on = request(socket, { v: 1, kind: "request", id: "2", op: "status" });
    expect(on.result.enabled).toBe(false);
    bridge.stop();
    void sessionId;
});

test("a dropped socket reconnects after the backoff delay", async () => {
    const { trace } = makeTrace();
    const bridge = createServerNetTraceBridge({
        url: URL,
        trace,
        packId: "probe",
        reconnectTicks: 20,
        onError: () => undefined,
    });
    bridge.start();
    await flush();
    expect(connectionAttempts).toHaveLength(1);

    sockets.at(-1).drop();
    await flush();
    expect(bridge.connected).toBe(false);

    await system.advanceTicks(19);
    await flush();
    expect(connectionAttempts).toHaveLength(1); // still inside the backoff window

    await system.advanceTicks(1);
    await flush();
    expect(connectionAttempts).toHaveLength(2);
    expect(bridge.connected).toBe(true);
    bridge.stop();
});

test("stop() cancels a scheduled reconnect without leaking a timer", async () => {
    const { trace } = makeTrace();
    connectFailures.push(new Error("down"));
    const bridge = createServerNetTraceBridge({
        url: URL,
        trace,
        packId: "probe",
        reconnectTicks: 50,
        onError: () => undefined,
    });
    bridge.start();
    await flush();
    expect(connectionAttempts).toHaveLength(1);
    expect(system.runs.size).toBeGreaterThan(0); // a reconnect is scheduled

    bridge.stop();
    expect(system.runs.size).toBe(0); // and cancelled

    await system.advanceTicks(10_000);
    await flush();
    expect(connectionAttempts).toHaveLength(1); // nothing fires after stop
});
