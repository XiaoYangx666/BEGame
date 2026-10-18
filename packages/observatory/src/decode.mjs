import {
    collectTraceExports,
    decodeBegTrace,
    decodeTraceLog,
    TRACE_MAGIC,
} from "@begame/trace";
import { analyzeSession } from "./analysis.mjs";

const decoder = new TextDecoder("utf-8", { fatal: false });

/** True when the buffer starts with the raw .begtrace container magic. */
export function looksLikeBegTrace(bytes) {
    if (bytes.length < TRACE_MAGIC.length) return false;
    for (let index = 0; index < TRACE_MAGIC.length; index++) {
        if (bytes[index] !== TRACE_MAGIC.charCodeAt(index)) return false;
    }
    return true;
}

function exportMetadata(entry) {
    return {
        sessionId: entry.sessionId,
        formatVersion: entry.formatVersion,
        partCount: entry.partCount,
        receivedParts: entry.receivedParts,
        missingParts: entry.missingParts,
        complete: entry.complete,
        lastOffset: entry.lastOffset,
    };
}

function buildStats(session) {
    const { header, end, events } = session;
    const typeCounts = Object.create(null);
    const sourceCounts = Object.create(null);
    const stateSpans = new Map();

    for (const event of events) {
        typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
        const kind = event.source.kind;
        sourceCounts[kind] = (sourceCounts[kind] ?? 0) + 1;

        if (kind !== "state" || event.source.ref === undefined) continue;
        const payload = event.payload;
        const payloadState =
            payload && typeof payload === "object" && !Array.isArray(payload) && "state" in payload
                ? String(payload.state)
                : undefined;
        let span = stateSpans.get(event.source.ref);
        if (!span) {
            span = {
                ref: event.source.ref,
                name: event.source.name ?? payloadState ?? `state#${event.source.ref}`,
                depth: null,
                enterTick: null,
                enterSequence: null,
                exitTick: null,
                exitSequence: null,
            };
            stateSpans.set(event.source.ref, span);
        }
        if (payload && typeof payload === "object" && typeof payload.depth === "number") {
            span.depth = payload.depth;
        }
        if (event.type === "state.enter") {
            if (span.enterTick === null) {
                span.enterTick = event.tick;
                span.enterSequence = event.sequence;
            }
        } else if (event.type === "state.exit") {
            if (span.exitTick === null) {
                span.exitTick = event.tick;
                span.exitSequence = event.sequence;
            }
        } else if (event.type === "state.remove" && span.exitTick === null) {
            span.exitTick = event.tick;
            span.exitSequence = event.sequence;
        }
    }

    const spans = [...stateSpans.values()]
        .map((span) => ({
            ...span,
            enterTick: span.enterTick ?? header.startTick,
            enterSequence: span.enterSequence ?? 0,
            exitTick: span.exitTick ?? end.endTick,
            exitSequence: span.exitSequence ?? end.eventCount,
        }))
        .sort((a, b) => a.enterSequence - b.enterSequence || (a.depth ?? 0) - (b.depth ?? 0));

    return {
        tickSpan: end.endTick - header.startTick,
        wallSpanMs: end.endWallTime - header.startWallTime,
        eventCount: end.eventCount,
        chunkCount: end.chunkCount,
        typeCounts,
        sourceCounts,
        stateSpans: spans,
    };
}

/**
 * @param {any} session
 * @returns {import("./types").SelectedSession}
 */
function buildSelected(session) {
    const selected = {
        sessionId: session.header.sessionId,
        header: session.header,
        end: session.end,
        events: session.events,
        stats: buildStats(session),
        context: buildContext(session),
    };
    selected.analysis = analyzeSession(selected);
    return selected;
}

const ERROR_TYPES = new Set([
    "component.error",
    "runner.uncaught_error",
    "game.start_failed",
    "event.callback_error",
]);

function isErrorEvent(type) {
    return (
        ERROR_TYPES.has(type) ||
        type.endsWith("_failed") ||
        type.endsWith("_rejected") ||
        type.endsWith(".failed") ||
        type.endsWith(".rejected")
    );
}

function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Groups events by their owning state instance and resolves player/seat
 * registries so the UI can show relationships instead of a flat event stream.
 */
export function buildContext(session) {
    const { header, end, events } = session;
    const nodes = new Map();
    const sessionNode = {
        key: "session",
        ref: null,
        name: "会话",
        depth: -1,
        parentKey: null,
        children: [],
        enterTick: header.startTick,
        exitTick: end.endTick,
        enterSequence: 0,
        exitSequence: end.eventCount,
        pushSequence: null,
        removeSequence: null,
        eventCount: 0,
        errorCount: 0,
    };
    nodes.set("session", sessionNode);

    const stack = [];
    const eventOwners = new Array(events.length);
    const players = new Map();
    const seats = new Map();
    const errors = [];

    const topKey = () => (stack.length ? `state:${stack.at(-1)}` : "session");

    const touchPlayer = (id, name, sequence, seat) => {
        if (typeof id !== "string" || id.length === 0) return;
        let player = players.get(id);
        if (!player) {
            player = {
                id,
                name: undefined,
                seats: [],
                firstSequence: sequence,
                lastSequence: sequence,
            };
            players.set(id, player);
        }
        if (name && player.name === undefined) player.name = name;
        if (seat !== undefined && !player.seats.includes(seat)) player.seats.push(seat);
        player.lastSequence = sequence;
    };

    for (let index = 0; index < events.length; index++) {
        const event = events[index];
        const payload = asRecord(event.payload);
        const ref = event.source.ref;

        if (event.type === "state.push" && ref !== undefined) {
            const key = `state:${ref}`;
            const parentKey = topKey();
            const node = {
                key,
                ref,
                name:
                    event.source.name ??
                    (typeof payload.state === "string" ? payload.state : undefined) ??
                    `state#${ref}`,
                depth: typeof payload.depth === "number" ? payload.depth : null,
                parentKey,
                children: [],
                enterTick: event.tick,
                exitTick: null,
                enterSequence: event.sequence,
                exitSequence: null,
                pushSequence: event.sequence,
                removeSequence: null,
                eventCount: 0,
                errorCount: 0,
            };
            nodes.set(key, node);
            (nodes.get(parentKey) ?? sessionNode).children.push(key);
            stack.push(ref);
            eventOwners[index] = key;
            node.eventCount++;
            continue;
        }

        if (event.type === "state.remove" && ref !== undefined) {
            const key = `state:${ref}`;
            const node = nodes.get(key);
            if (node) {
                node.removeSequence = event.sequence;
                if (node.exitTick === null) node.exitTick = event.tick;
                if (node.exitSequence === null) node.exitSequence = event.sequence;
                node.eventCount++;
                eventOwners[index] = key;
            } else {
                eventOwners[index] = topKey();
            }
            const stackIndex = stack.indexOf(ref);
            if (stackIndex >= 0) stack.splice(stackIndex, 1);
            continue;
        }

        let key;
        if (
            (event.type === "state.enter" || event.type === "state.exit") &&
            ref !== undefined &&
            nodes.has(`state:${ref}`)
        ) {
            key = `state:${ref}`;
        } else if (
            event.source.kind === "state" &&
            ref !== undefined &&
            nodes.has(`state:${ref}`)
        ) {
            key = `state:${ref}`;
        } else {
            key = topKey();
        }

        const node = nodes.get(key) ?? sessionNode;
        eventOwners[index] = node.key;
        node.eventCount++;
        if (isErrorEvent(event.type)) {
            node.errorCount++;
            errors.push({ eventIndex: index, nodeKey: node.key, type: event.type });
        }

        if (event.type === "state.enter" && ref !== undefined) {
            const target = nodes.get(`state:${ref}`);
            if (target) {
                target.enterTick = event.tick;
                target.enterSequence = event.sequence;
            }
        } else if (event.type === "state.exit" && ref !== undefined) {
            const target = nodes.get(`state:${ref}`);
            if (target && target.exitTick === null) {
                target.exitTick = event.tick;
                target.exitSequence = event.sequence;
            }
        }

        // Seat ids are game-defined: both numeric (cards) and named (chess)
        // seats are valid. Never coerce a named id to a number.
        const seat =
            typeof payload.seat === "number" && Number.isFinite(payload.seat)
                ? payload.seat
                : typeof payload.seat === "string" && payload.seat.length > 0
                  ? payload.seat
                  : undefined;
        if (typeof payload.player === "string") {
            touchPlayer(payload.player, undefined, event.sequence, seat);
        }
        if (typeof payload.participantId === "string") {
            touchPlayer(payload.participantId, payload.name, event.sequence, seat);
        }
        if (
            seat !== undefined &&
            (typeof payload.kind === "string" || typeof payload.name === "string")
        ) {
            let entry = seats.get(seat);
            if (!entry) {
                entry = {
                    seat,
                    name: undefined,
                    kind: undefined,
                    participantId: undefined,
                    firstSequence: event.sequence,
                    lastSequence: event.sequence,
                    changes: [],
                };
                seats.set(seat, entry);
            }
            // A full seat change replaces its occupant. In particular,
            // clearing a seat must not keep the previous player's name/ID.
            if (payload.kind !== undefined) {
                entry.kind = String(payload.kind);
                entry.name = typeof payload.name === "string" ? payload.name : undefined;
                entry.participantId =
                    typeof payload.participantId === "string" ? payload.participantId : undefined;
            } else {
                if (payload.name !== undefined) entry.name = String(payload.name);
                if (payload.participantId !== undefined) entry.participantId = String(payload.participantId);
            }
            entry.lastSequence = event.sequence;
            entry.changes.push({
                sequence: event.sequence,
                tick: event.tick,
                kind: payload.kind,
                name: payload.name,
                participantId: payload.participantId,
            });
        }
    }

    return {
        nodes: [...nodes.values()],
        eventOwners,
        players: [...players.values()].sort(
            (a, b) => a.firstSequence - b.firstSequence
        ),
        seats: [...seats.values()].sort((a, b) =>
            typeof a.seat === "number" && typeof b.seat === "number"
                ? a.seat - b.seat
                : String(a.seat).localeCompare(String(b.seat), undefined, { numeric: true })
        ),
        errors,
    };
}


/**
 * Decode one payload: raw .begtrace bytes or Content Log text.
 * Never throws for expected input problems; returns `{ ok: false, error }` instead.
 * @param {Uint8Array | ArrayBuffer} input
 * @param {string} [sessionId]
 * @returns {import("./types").DecodeResponse}
 */
export function decodeTracePayload(input, sessionId) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

    if (looksLikeBegTrace(bytes)) {
        const session = decodeBegTrace(bytes);
        const selected = buildSelected(session);
        return {
            ok: true,
            source: "begtrace",
            exports: [
                {
                    sessionId: session.header.sessionId,
                    formatVersion: session.header.formatVersion,
                    partCount: 1,
                    receivedParts: [1],
                    missingParts: [],
                    complete: true,
                    lastOffset: 0,
                },
            ],
            selected,
            analysis: selected.analysis,
            warnings: [],
        };
    }

    const content = decoder.decode(bytes);
    const exports = collectTraceExports(content);
    const metadata = exports.map(exportMetadata);

    let chosen;
    if (sessionId) {
        chosen = exports.find((entry) => entry.sessionId === sessionId);
        if (!chosen) {
            return {
                ok: false,
                source: "log",
                error: `日志中未找到 session：${sessionId}`,
                exports: metadata,
            };
        }
        if (!chosen.complete) {
            return {
                ok: false,
                source: "log",
                error: `导出不完整，缺少分片：${chosen.missingParts.join(", ")}`,
                requestedSessionId: sessionId,
                exports: metadata,
            };
        }
    } else {
        chosen = [...exports].reverse().find((entry) => entry.complete);
        if (!chosen) {
            const latest = exports.at(-1);
            if (!latest) {
                return {
                    ok: false,
                    source: "log",
                    error: "没有找到 BEGAME_TRACE 标记",
                    exports: metadata,
                };
            }
            return {
                ok: false,
                source: "log",
                error: `导出不完整，缺少分片：${latest.missingParts.join(", ")}`,
                requestedSessionId: latest.sessionId,
                exports: metadata,
            };
        }
    }

    const session = decodeTraceLog(content, chosen.sessionId);
    const selected = buildSelected(session);
    return {
        ok: true,
        source: "log",
        exports: metadata,
        selectedSessionId: chosen.sessionId,
        selected,
        analysis: selected.analysis,
        warnings: [],
    };
}
