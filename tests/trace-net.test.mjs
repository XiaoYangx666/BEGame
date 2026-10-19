import { expect, test } from "vitest";
import {
    parseTraceNetReply,
    parseTraceNetRequest,
    TRACE_NET_VERSION,
} from "../packages/trace/dist/index.js";

test("requests round-trip through the parser", () => {
    const cases = [
        { v: 1, kind: "request", id: "a", op: "list" },
        { v: 1, kind: "request", id: "a2", op: "list", since: 7 },
        { v: 1, kind: "request", id: "b", op: "begin", sessionId: "s" },
        { v: 1, kind: "request", id: "c", op: "part", sessionId: "s", part: 3 },
        { v: 1, kind: "request", id: "d", op: "delete", sessionId: "s" },
        { v: 1, kind: "request", id: "e", op: "store", enabled: true },
    ];
    for (const value of cases) {
        expect(parseTraceNetRequest(value)).toEqual(value);
    }
});

test("malformed requests are rejected", () => {
    expect(parseTraceNetRequest(null)).toBeUndefined();
    expect(parseTraceNetRequest({ v: 2, kind: "request", id: "a", op: "list" })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", op: "list" })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "begin" })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "part", sessionId: "s", part: -1 })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "store" })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "nope" })).toBeUndefined();
    // `since` is optional, but when present it must be a non-negative integer.
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "list", since: -1 })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "list", since: 1.5 })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "list", since: "1" })).toBeUndefined();
    expect(parseTraceNetRequest({ v: 1, kind: "request", id: "a", op: "list", since: 0 })).toEqual({
        v: 1,
        kind: "request",
        id: "a",
        op: "list",
        since: 0,
    });
});

test("replies are recognized structurally", () => {
    expect(
        parseTraceNetReply({
            v: TRACE_NET_VERSION,
            kind: "ready",
            protocolVersion: 1,
            store: { enabled: true, acceptingSessions: true, count: 0, running: 0 },
        })?.kind
    ).toBe("ready");
    expect(
        parseTraceNetReply({
            v: 1,
            kind: "response",
            id: "a",
            op: "list",
            ok: true,
            result: { sessions: [] },
        })?.kind
    ).toBe("response");
    // New full listings and unchanged acknowledgements are still one reply shape.
    expect(
        parseTraceNetReply({
            v: 1,
            kind: "response",
            id: "b",
            op: "list",
            ok: true,
            result: {
                revision: 3,
                store: { enabled: true, acceptingSessions: true, count: 0, running: 0, revision: 3 },
                sessions: [],
            },
        })?.kind
    ).toBe("response");
    expect(
        parseTraceNetReply({
            v: 1,
            kind: "response",
            id: "c",
            op: "list",
            ok: true,
            result: {
                unchanged: true,
                revision: 3,
                store: { enabled: true, acceptingSessions: true, count: 0, running: 0, revision: 3 },
            },
        })?.kind
    ).toBe("response");
    expect(
        parseTraceNetReply({
            v: 1,
            kind: "response",
            id: "d",
            op: "list",
            ok: true,
            result: {
                sessions: [],
                removed: ["gone"],
                full: false,
                revision: 4,
                store: { enabled: true, acceptingSessions: true, count: 0, running: 0, revision: 4 },
            },
        })?.kind
    ).toBe("response");
    expect(parseTraceNetReply({ v: 1, kind: "response", id: "a", op: "list" })).toBeUndefined();
});
