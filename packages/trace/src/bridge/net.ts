/**
 * Bidirectional wire protocol for the BDS trace bridge.
 *
 * Bedrock Dedicated Server connects out with `@minecraft/server-net`'s
 * WebSocket client, and the Observatory uses that single socket to both query
 * the on-server history store and drive management operations. This module is
 * platform-independent so the game side and the Observatory share exactly one
 * definition of every message.
 *
 * Requests flow Observatory -> game; replies and the initial `ready` handshake
 * flow game -> Observatory.
 */
import type { StoredTraceSummary } from "../wire/types";

export const TRACE_NET_VERSION = 1;
/** Base64 characters per `part` reply. Keeps each frame well under socket limits. */
export const TRACE_NET_PART_CHARS = 384 * 1024;

export type TraceNetOp =
    | "list"
    | "begin"
    | "part"
    | "delete"
    | "clear"
    | "store"
    | "status";

export interface TraceNetStoreStatus {
    readonly enabled: boolean;
    readonly acceptingSessions: boolean;
    readonly count: number;
    readonly running: number;
    /**
     * Monotonic listing revision of the pack's history store. Absent on packs
     * that predate revision tracking (protocol version 1 without the addition).
     */
    readonly revision?: number;
}

/**
 * Full listing, an incremental delta, or a tiny acknowledgement when the
 * caller's cached revision is still current.
 */
export type TraceNetListResult =
    | {
          readonly unchanged: true;
          readonly revision: number;
          readonly store: TraceNetStoreStatus;
      }
    | {
          readonly sessions: readonly StoredTraceSummary[];
          /**
           * Sessions deleted after the caller's `since`. `full: false` replies
           * always include it; full replies normally send an empty array.
           */
          readonly removed?: readonly string[];
          /**
           * `false` means `sessions` is a delta and `removed` must be applied.
           * Absent on packs that predate incremental listings; treat those as
           * full replacements.
           */
          readonly full?: boolean;
          /** Absent on packs that predate revision tracking. */
          readonly revision?: number;
          /** Absent on packs that predate the combined list/store reply. */
          readonly store?: TraceNetStoreStatus;
      };

/** Observatory -> game. */
export type TraceNetRequest =
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "request";
          readonly id: string;
          readonly op: "list";
          /**
           * Revision the caller already has. When it matches the store, the
           * reply is `{ unchanged: true, ... }` with no session list.
           */
          readonly since?: number;
      }
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "request";
          readonly id: string;
          readonly op: "clear" | "status";
      }
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "request";
          readonly id: string;
          readonly op: "begin" | "delete";
          readonly sessionId: string;
      }
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "request";
          readonly id: string;
          readonly op: "part";
          readonly sessionId: string;
          readonly part: number;
      }
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "request";
          readonly id: string;
          readonly op: "store";
          readonly enabled: boolean;
      };

/**
 * Result payloads. The reply carries `op`, so consumers narrow on that rather
 * than on the shape.
 */
export type TraceNetResult =
    | TraceNetListResult
    | { readonly sessionId: string; readonly parts: number; readonly chars: number }
    | { readonly sessionId: string; readonly part: number; readonly data: string }
    | { readonly sessionId: string; readonly deleted: boolean }
    | { readonly removed: number }
    | TraceNetStoreStatus;

/** Game -> Observatory. */
export type TraceNetReply =
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "ready";
          readonly protocolVersion: number;
          /** Stable identity of the pack, used to route requests back to it. */
          readonly packId?: string;
          readonly packName?: string;
          readonly store: TraceNetStoreStatus;
      }
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "response";
          readonly id: string;
          readonly op: TraceNetOp;
          readonly ok: true;
          readonly result: TraceNetResult;
      }
    | {
          readonly v: typeof TRACE_NET_VERSION;
          readonly kind: "response";
          readonly id: string;
          readonly op: TraceNetOp;
          readonly ok: false;
          readonly error: string;
      };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function parseTraceNetRequest(value: unknown): TraceNetRequest | undefined {
    if (!isRecord(value) || value.v !== TRACE_NET_VERSION || value.kind !== "request") {
        return undefined;
    }
    const id = value.id;
    if (typeof id !== "string" || id.length === 0) return undefined;
    switch (value.op) {
        case "list":
            if (value.since === undefined) {
                return { v: TRACE_NET_VERSION, kind: "request", id, op: "list" };
            }
            if (!Number.isSafeInteger(value.since) || (value.since as number) < 0) {
                return undefined;
            }
            return {
                v: TRACE_NET_VERSION,
                kind: "request",
                id,
                op: "list",
                since: value.since as number,
            };
        case "clear":
        case "status":
            return { v: TRACE_NET_VERSION, kind: "request", id, op: value.op };
        case "begin":
        case "delete":
            if (!isSessionId(value.sessionId)) return undefined;
            return {
                v: TRACE_NET_VERSION,
                kind: "request",
                id,
                op: value.op,
                sessionId: value.sessionId,
            };
        case "part":
            if (!isSessionId(value.sessionId)) return undefined;
            if (!Number.isSafeInteger(value.part) || (value.part as number) < 0) {
                return undefined;
            }
            return {
                v: TRACE_NET_VERSION,
                kind: "request",
                id,
                op: "part",
                sessionId: value.sessionId,
                part: value.part as number,
            };
        case "store":
            if (typeof value.enabled !== "boolean") return undefined;
            return { v: TRACE_NET_VERSION, kind: "request", id, op: "store", enabled: value.enabled };
        default:
            return undefined;
    }
}

/** Structural check for replies the game sent. Payloads are validated by use. */
export function parseTraceNetReply(value: unknown): TraceNetReply | undefined {
    if (!isRecord(value) || value.v !== TRACE_NET_VERSION) return undefined;
    if (value.kind === "ready") {
        if (!isRecord(value.store)) return undefined;
        return value as unknown as TraceNetReply;
    }
    if (value.kind !== "response") return undefined;
    if (typeof value.id !== "string" || typeof value.op !== "string") return undefined;
    if (typeof value.ok !== "boolean") return undefined;
    return value as unknown as TraceNetReply;
}
