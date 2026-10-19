/**
 * HTTP upload sink for Bedrock Dedicated Server.
 *
 * `@minecraft/server-net` only exists on BDS, so this module is a separate
 * entry: packs that also run in the client bundle their client entry instead and
 * never reference this file. Consumers must keep `@minecraft/server-net`
 * external (BePack does this automatically for managed dependencies).
 *
 * Core never awaits a sink and never lets sink failures affect gameplay, so the
 * sink owns a bounded queue and delivers sessions in the background.
 */
import { system } from "@minecraft/server";
import {
    HttpHeader,
    HttpRequest,
    HttpRequestMethod,
    type WebSocketClient,
    http,
    websocket,
} from "@minecraft/server-net";
import { encodeBase64 } from "./wire/base64";
import { encodeBegTrace } from "./wire/container";
import { encodeTraceIngestParts } from "./bridge/ingest";
import {
    TRACE_NET_PART_CHARS,
    TRACE_NET_VERSION,
    parseTraceNetRequest,
    type TraceNetReply,
    type TraceNetRequest,
    type TraceNetResult,
    type TraceNetStoreStatus,
} from "./bridge/net";
import type {
    StoredTraceSummary,
    TraceChunk,
    TraceSessionEnd,
    TraceSessionHeader,
    TraceSink,
} from "./wire/types";
import type { TraceListingDelta } from "./runtime/historyStore";

export interface ServerNetTraceSinkOptions {
    /** Full ingest endpoint, e.g. `http://127.0.0.1:8787/api/ingest`. */
    readonly url: string;
    /** Optional shared token, sent as the `x-begame-token` header. */
    readonly token?: string;
    /** Per-request timeout in seconds. Defaults to 10. */
    readonly timeoutSeconds?: number;
    /**
     * Maximum bytes held by buffered sessions and queued uploads combined.
     * Oldest queued uploads are dropped once the budget is exceeded, so a slow
     * or unreachable Observatory can never grow the server's memory unbounded.
     * Defaults to 16 MiB.
     */
    readonly maxBufferedBytes?: number;
    /** Receives every delivery/queue failure. Defaults to `console.error`. */
    readonly onError?: (error: unknown) => void;
}

interface BufferedSession {
    readonly header: TraceSessionHeader;
    readonly chunks: { bytes: Uint8Array }[];
    bytes: number;
}

interface QueuedUpload {
    readonly sessionId: string;
    readonly bytes: Uint8Array;
}

/**
 * Builds a `TraceSink` that pushes completed sessions to the Observatory.
 *
 * Attach it to the runtime the pack already owns:
 *
 * ```ts
 * const trace = createTraceRuntime();
 * trace.setSink(createServerNetTraceSink({ url: "http://127.0.0.1:8787/api/ingest" }));
 * ```
 */
export function createServerNetTraceSink(
    options: ServerNetTraceSinkOptions
): TraceSink {
    const timeoutSeconds = options.timeoutSeconds ?? 10;
    const maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
    const report =
        options.onError ??
        ((error: unknown) => {
            console.error("[BEGame] server-net trace upload failed:", error);
        });

    const pending = new Map<string, BufferedSession>();
    const queue: QueuedUpload[] = [];
    let draining = false;

    function queuedBytes() {
        return queue.reduce((sum, upload) => sum + upload.bytes.length, 0);
    }

    function enqueue(upload: QueuedUpload) {
        if (upload.bytes.length > maxBufferedBytes) {
            report(
                new Error(
                    `trace ${upload.sessionId} exceeds the upload budget (${upload.bytes.length} bytes)`
                )
            );
            return;
        }
        let total = queuedBytes();
        while (queue.length > 0 && total + upload.bytes.length > maxBufferedBytes) {
            const dropped = queue.shift()!;
            total -= dropped.bytes.length;
            report(new Error(`dropped queued trace ${dropped.sessionId} (upload backlog)`));
        }
        queue.push(upload);
        void drain();
    }

    async function drain() {
        if (draining) return;
        draining = true;
        try {
            while (queue.length > 0) {
                const upload = queue.shift()!;
                try {
                    await deliver(upload);
                } catch (error) {
                    report(error);
                }
            }
        } finally {
            draining = false;
        }
    }

    async function deliver(upload: QueuedUpload) {
        for (const part of encodeTraceIngestParts(upload.sessionId, upload.bytes)) {
            const request = new HttpRequest(options.url)
                .setMethod(HttpRequestMethod.Post)
                .setTimeout(timeoutSeconds)
                .addHeader("content-type", "application/json");
            if (options.token) request.addHeader("x-begame-token", options.token);
            request.setBody(JSON.stringify(part));
            const response = await http.request(request);
            if (response.status < 200 || response.status >= 300) {
                throw new Error(
                    `ingest rejected ${upload.sessionId} part ${part.part}: HTTP ${response.status}`
                );
            }
        }
    }

    return {
        onSessionStart(header) {
            pending.set(header.sessionId, { header, chunks: [], bytes: 0 });
        },
        onChunk(chunk: TraceChunk) {
            const session = pending.get(chunk.sessionId);
            if (!session) return;
            session.chunks.push({ bytes: chunk.bytes });
            session.bytes += chunk.bytes.length;
            if (session.bytes > maxBufferedBytes) {
                pending.delete(chunk.sessionId);
                report(
                    new Error(
                        `trace ${chunk.sessionId} exceeded the buffer budget and was dropped`
                    )
                );
            }
        },
        onSessionEnd(end: TraceSessionEnd) {
            const session = pending.get(end.sessionId);
            if (!session) return;
            pending.delete(end.sessionId);
            enqueue({
                sessionId: end.sessionId,
                bytes: encodeBegTrace(session.header, session.chunks, end),
            });
        },
    };
}

/**
 * The slice of the trace runtime the WebSocket bridge needs. `TraceManager`
 * satisfies it, and keeping it structural lets tests use a tiny fake.
 */
export interface ServerNetTraceSource {
    readonly store: {
        list(): StoredTraceSummary[];
        listSince(since: number | undefined): TraceListingDelta;
        delete(sessionId: string): boolean;
        enable(): unknown;
        disable(): unknown;
        readonly enabled: boolean;
        readonly acceptingSessions: boolean;
        /** Monotonic revision of the listing snapshot. */
        readonly revision: number;
    };
    snapshotBytes(sessionId: string): Uint8Array;
}

export interface ServerNetTraceBridgeOptions {
    /** WebSocket endpoint of the Observatory, e.g. `ws://127.0.0.1:18790/`. */
    readonly url: string;
    /** Optional shared token, sent as the `x-begame-token` header. */
    readonly token?: string;
    /** The runtime whose history store the Observatory may query and manage. */
    readonly trace: ServerNetTraceSource;
    /** Stable identity for this pack; the Observatory routes requests by it. */
    readonly packId: string;
    readonly packName?: string;
    /** Base64 characters per `part` reply. Defaults to {@link TRACE_NET_PART_CHARS}. */
    readonly partChars?: number;
    /** Delay before the first reconnect, in ticks. Defaults to 100 (5 seconds). */
    readonly reconnectTicks?: number;
    /**
     * Ceiling for the reconnect backoff, in ticks. Defaults to 1200 (60 seconds).
     * Each consecutive failure doubles the delay from {@link reconnectTicks} up
     * to this value.
     */
    readonly maxReconnectTicks?: number;
    /**
     * Pause reconnecting after this many consecutive failed connects, until
     * {@link ServerNetTraceBridge.start} is called again. Defaults to 8.
     *
     * BDS's beta `@minecraft/server-net` WebSocket aborts the whole server when
     * it is hammered with failed connects (e.g. the Observatory is not running),
     * so the bridge gives up instead of retrying forever. Set higher values only
     * if you accept that risk.
     */
    readonly maxConsecutiveFailures?: number;
    /** Receives connection/protocol failures. Defaults to `console.error`. */
    readonly onError?: (error: unknown) => void;
}

export interface ServerNetTraceBridge {
    /** Connect (or reconnect). Resumes a bridge that paused after failures. */
    start(): void;
    /** Disconnect and stop reconnecting. */
    stop(): void;
    readonly connected: boolean;
    /** True after the consecutive-failure cap was hit; `start()` resumes it. */
    readonly suspended: boolean;
}

/**
 * Connects a BDS pack to the Observatory over `@minecraft/server-net`'s
 * WebSocket client and serves history queries/management on that socket.
 *
 * Unlike the HTTP sink, this is bidirectional: the Observatory drives `list`,
 * `begin`/`part`, `delete`, `clear` and store toggling, so it can inspect every
 * stored session instead of only receiving finished ones.
 */
export function createServerNetTraceBridge(
    options: ServerNetTraceBridgeOptions
): ServerNetTraceBridge {
    const partChars = Math.max(1, Math.floor(options.partChars ?? TRACE_NET_PART_CHARS));
    const baseReconnectTicks = Math.max(1, Math.floor(options.reconnectTicks ?? 100));
    const maxReconnectTicks = Math.max(
        baseReconnectTicks,
        Math.floor(options.maxReconnectTicks ?? 1200)
    );
    const maxConsecutiveFailures = Math.max(
        1,
        Math.floor(options.maxConsecutiveFailures ?? 8)
    );
    const report =
        options.onError ??
        ((error: unknown) => {
            console.error("[BEGame] server-net trace bridge error:", error);
        });

    let socket: WebSocketClient | undefined;
    let stopped = true;
    let suspended = false;
    let connecting = false;
    let reconnectRun: number | undefined;
    let consecutiveFailures = 0;
    let connectFailureReported = false;
    let cached: { sessionId: string; base64: string } | undefined;
    /**
     * Counts derived from the last listing. A revision match proves the listing
     * cannot have changed, so an `unchanged` reply can still report store status
     * without calling `list()` (and rebuilding/scanning it) again.
     */
    let listingCounts:
        | { revision: number; count: number; running: number }
        | undefined;

    function storeStatus(): TraceNetStoreStatus {
        const revision = options.trace.store.revision;
        if (listingCounts?.revision !== revision) {
            recordListing(revision, options.trace.store.list());
        }
        return {
            enabled: options.trace.store.enabled,
            acceptingSessions: options.trace.store.acceptingSessions,
            count: listingCounts!.count,
            running: listingCounts!.running,
            revision,
        };
    }

    function recordListing(revision: number, sessions: readonly StoredTraceSummary[]) {
        listingCounts = {
            revision,
            count: sessions.length,
            running: sessions.filter((entry) => entry.status === "running").length,
        };
    }

    function safeStoreStatus(): TraceNetStoreStatus {
        try {
            return storeStatus();
        } catch {
            // Dynamic properties are not readable before worldLoad.
            return {
                enabled: options.trace.store.enabled,
                acceptingSessions: false,
                count: 0,
                running: 0,
                revision: options.trace.store.revision,
            };
        }
    }

    function perform(request: TraceNetRequest): TraceNetResult {
        switch (request.op) {
            case "list": {
                const revision = options.trace.store.revision;
                if (request.since !== undefined && request.since === revision) {
                    // The caller's snapshot is current: no session reads or
                    // serialization, just a small acknowledgement.
                    return { unchanged: true, revision, store: storeStatus() };
                }
                const delta = options.trace.store.listSince(request.since);
                if (delta.full) recordListing(delta.revision, delta.sessions);
                return {
                    sessions: delta.sessions,
                    removed: delta.removed,
                    full: delta.full,
                    revision: delta.revision,
                    store: storeStatus(),
                };
            }
            case "status":
            case "store": {
                if (request.op === "store") {
                    if (request.enabled) options.trace.store.enable();
                    else options.trace.store.disable();
                }
                return storeStatus();
            }
            case "begin": {
                const base64 = encodeBase64(options.trace.snapshotBytes(request.sessionId));
                cached = { sessionId: request.sessionId, base64 };
                return {
                    sessionId: request.sessionId,
                    parts: Math.max(1, Math.ceil(base64.length / partChars)),
                    chars: base64.length,
                };
            }
            case "part": {
                if (!cached || cached.sessionId !== request.sessionId) {
                    throw new Error("request_info_first");
                }
                const start = request.part * partChars;
                if (start >= cached.base64.length) throw new Error("invalid_part");
                return {
                    sessionId: request.sessionId,
                    part: request.part,
                    data: cached.base64.slice(start, start + partChars),
                };
            }
            case "delete":
                return {
                    sessionId: request.sessionId,
                    deleted: options.trace.store.delete(request.sessionId),
                };
            case "clear": {
                let removed = 0;
                for (const entry of options.trace.store.list()) {
                    if (entry.status === "running") continue;
                    if (options.trace.store.delete(entry.sessionId)) removed++;
                }
                return { removed };
            }
        }
    }

    function send(message: TraceNetReply) {
        if (!socket?.isOpen) return;
        try {
            socket.send(JSON.stringify(message));
        } catch (error) {
            report(error);
        }
    }

    function handle(text: string) {
        let request: TraceNetRequest | undefined;
        try {
            request = parseTraceNetRequest(JSON.parse(text));
        } catch {
            return;
        }
        if (!request) return;
        try {
            const result = perform(request);
            send({
                v: TRACE_NET_VERSION,
                kind: "response",
                id: request.id,
                op: request.op,
                ok: true,
                result,
            });
        } catch (error) {
            send({
                v: TRACE_NET_VERSION,
                kind: "response",
                id: request.id,
                op: request.op,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /** Exponential backoff: 1x, 2x, 4x ... of the base delay, capped. */
    function reconnectDelayTicks() {
        const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
        return Math.min(baseReconnectTicks * 2 ** exponent, maxReconnectTicks);
    }

    function scheduleReconnect() {
        if (stopped || suspended || reconnectRun !== undefined) return;
        reconnectRun = system.runTimeout(() => {
            reconnectRun = undefined;
            void connect();
        }, reconnectDelayTicks());
    }

    /**
     * Record a failed connect. The first failure is reported, later ones stay
     * quiet until the cap pauses the bridge, which is reported once more.
     */
    function fail(error: unknown) {
        consecutiveFailures++;
        if (!connectFailureReported) {
            connectFailureReported = true;
            report(error);
        }
        if (consecutiveFailures >= maxConsecutiveFailures) {
            suspended = true;
            report(
                new Error(
                    `server-net trace bridge paused after ${consecutiveFailures} failed connects to ${options.url}; call start() to retry`
                )
            );
            return;
        }
        scheduleReconnect();
    }

    async function connect() {
        if (stopped || suspended || connecting || socket?.isOpen) return;
        connecting = true;
        try {
            const headers = options.token
                ? [new HttpHeader("x-begame-token", options.token)]
                : undefined;
            const next = await websocket.connect(options.url, headers);
            if (stopped) {
                next.close();
                return;
            }
            socket = next;
            consecutiveFailures = 0;
            connectFailureReported = false;
            next.afterEvents.message.subscribe((event) => handle(event.message));
            next.afterEvents.close.subscribe(() => {
                if (socket === next) socket = undefined;
                scheduleReconnect();
            });
            send({
                v: TRACE_NET_VERSION,
                kind: "ready",
                protocolVersion: TRACE_NET_VERSION,
                packId: options.packId,
                ...(options.packName === undefined ? {} : { packName: options.packName }),
                store: safeStoreStatus(),
            });
        } catch (error) {
            // The server's network stack may not be ready when worldLoad fires, so
            // the first attempts can fail. `fail` backs off and eventually pauses
            // instead of hammering `websocket.connect` forever.
            fail(error);
        } finally {
            connecting = false;
        }
    }

    return {
        start() {
            if (!stopped && !suspended) return;
            stopped = false;
            suspended = false;
            consecutiveFailures = 0;
            connectFailureReported = false;
            void connect();
        },
        stop() {
            stopped = true;
            suspended = false;
            if (reconnectRun !== undefined) {
                system.clearRun(reconnectRun);
                reconnectRun = undefined;
            }
            try {
                socket?.close();
            } catch {
                // Closing an already-closed socket is not an error worth reporting.
            }
            socket = undefined;
            consecutiveFailures = 0;
            connectFailureReported = false;
        },
        get connected() {
            return Boolean(socket?.isOpen);
        },
        get suspended() {
            return suspended;
        },
    };
}
