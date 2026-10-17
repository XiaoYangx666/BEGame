import { decodeBase64, encodeBase64 } from "../wire/base64";
import { encodeBegTrace, type BegTraceContainer } from "../wire/container";
import { createInMemoryStorage, type TraceStorage } from "./storage";
import {
    TRACE_FORMAT_VERSION,
    type StoredTraceSummary,
    type TraceChunk,
    type TraceSessionEnd,
    type TraceSessionHeader,
    type TraceSessionStatus,
    type TraceSink,
    type TraceStoreOptions,
} from "../wire/types";

const STORE_PREFIX = `begame.trace.v${TRACE_FORMAT_VERSION}.`;
/**
 * Persisted on/off flag. Lives in the same versioned namespace as sessions but
 * does not end in `.meta`, so `list()`/`cleanup()`/`clear()` ignore it.
 */
const ENABLED_KEY = `${STORE_PREFIX}enabled`;
const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_TICKS = 6000;

interface TraceHistoryMetaV1 {
    readonly storageVersion: 1;
    readonly header: TraceSessionHeader;
    status: TraceSessionStatus;
    chunkCount: number;
    eventCount: number;
    lastTick: number;
    storedBytes: number;
    end?: TraceSessionEnd;
}

/**
 * Persistent trace history with a bounded retention policy.
 *
 * Writes session chunks through the injected {@link TraceStorage} seams, so the
 * bookkeeping here — ordering, retention, reload recovery, "an accepted session
 * must finish atomically" — is platform-independent. `./minecraft` supplies
 * Minecraft dynamic properties; the default is an in-memory map.
 *
 * This is a history store, not an export transport: the log parser and the
 * console exporter read completed sessions back out of it.
 */
export class TraceHistoryStore implements TraceSink {
    private options: Required<TraceStoreOptions> = {
        maxSessions: DEFAULT_MAX_SESSIONS,
        maxBytes: DEFAULT_MAX_BYTES,
        maxAgeMs: DEFAULT_MAX_AGE_MS,
        cleanupIntervalTicks: DEFAULT_CLEANUP_INTERVAL_TICKS,
    };
    private _enabled = false;
    private cleanupRunId?: number;
    private cancelMaintenanceWait?: () => void;
    private recoverOnMaintenance = false;
    /** Sessions that were accepted while storage was enabled must finish atomically. */
    private readonly activeSessions = new Set<string>();

    constructor(
        private readonly storage: TraceStorage = createInMemoryStorage(),
        options: TraceStoreOptions = {},
        private readonly onInternalError?: (error: unknown) => void
    ) {
        this.configure(options);
    }

    get enabled() {
        return this._enabled;
    }

    /** Whether new sessions can safely be persisted right now. */
    get acceptingSessions() {
        return this._enabled && this.storage.gate.isReady();
    }

    get config(): Readonly<Required<TraceStoreOptions>> {
        return { ...this.options };
    }

    /** Update retention settings without changing the enabled state. */
    configure(options: TraceStoreOptions = {}) {
        const previousInterval = this.options.cleanupIntervalTicks;
        this.options = {
            maxSessions: positiveInteger(
                options.maxSessions ?? this.options.maxSessions,
                "maxSessions"
            ),
            maxBytes: positiveInteger(
                options.maxBytes ?? this.options.maxBytes,
                "maxBytes"
            ),
            maxAgeMs: positiveNumber(
                options.maxAgeMs ?? this.options.maxAgeMs,
                "maxAgeMs"
            ),
            cleanupIntervalTicks: positiveInteger(
                options.cleanupIntervalTicks ?? this.options.cleanupIntervalTicks,
                "cleanupIntervalTicks"
            ),
        };

        if (
            this._enabled &&
            previousInterval !== this.options.cleanupIntervalTicks
        ) {
            this.stopCleanupTimer();
        }
        if (this._enabled) this.scheduleMaintenance();
        return this;
    }

    /**
     * Enable persistence for newly-created Trace Sessions and persist the choice.
     * Existing running sessions that started while disabled are intentionally not
     * attached mid-stream because doing so would create incomplete history.
     */
    enable() {
        this.setEnabled(true, true);
        return this;
    }

    /**
     * Stop accepting new sessions and persist the choice. Sessions already accepted
     * continue until their footer is committed, so toggling storage never
     * deliberately creates a half trace.
     */
    disable() {
        this.setEnabled(false, true);
        return this;
    }

    /**
     * Apply the persisted enabled state, defaulting to disabled. Unlike
     * {@link enable}/{@link disable} this never writes, so a pack can call it once
     * after worldLoad and keep whatever the Observatory or a command last set.
     */
    restoreEnabled() {
        const apply = () => {
            let enabled = false;
            try {
                enabled = this.storage.kv.get(ENABLED_KEY) === true;
            } catch (error) {
                this.report(error);
            }
            this.setEnabled(enabled, false);
        };
        if (this.storage.gate.isReady()) apply();
        else this.storage.gate.afterReady(apply);
        return this;
    }

    private setEnabled(enabled: boolean, persist: boolean) {
        if (enabled) {
            if (!this._enabled) {
                this._enabled = true;
                this.recoverOnMaintenance = true;
                // The substrate may not be safe to touch yet (Minecraft dynamic
                // properties are unusable before worldLoad), so recovery, cleanup
                // and periodic maintenance all wait for the gate.
                this.scheduleMaintenance();
            }
        } else if (this._enabled) {
            this._enabled = false;
            this.recoverOnMaintenance = false;
            this.cancelMaintenanceWait?.();
            this.cancelMaintenanceWait = undefined;
            this.stopCleanupTimer();
        }
        if (persist) this.persistEnabled(enabled);
    }

    private persistEnabled(enabled: boolean) {
        const write = () => {
            try {
                this.storage.kv.set(ENABLED_KEY, enabled);
            } catch (error) {
                this.report(error);
            }
        };
        if (this.storage.gate.isReady()) write();
        else this.storage.gate.afterReady(write);
    }

    onSessionStart(header: TraceSessionHeader) {
        if (!this.acceptingSessions) return;
        const meta: TraceHistoryMetaV1 = {
            storageVersion: 1,
            header,
            status: "running",
            chunkCount: 0,
            eventCount: 0,
            lastTick: header.startTick,
            storedBytes: 0,
        };
        this.writeMeta(meta);
        this.activeSessions.add(header.sessionId);
    }

    onChunk(chunk: TraceChunk) {
        if (!this.activeSessions.has(chunk.sessionId)) return;
        const meta = this.requireMeta(chunk.sessionId);
        if (chunk.index !== meta.chunkCount) {
            throw new Error(
                `Trace chunk out of order for ${chunk.sessionId}: expected ${meta.chunkCount}, got ${chunk.index}`
            );
        }

        const encoded = encodeBase64(chunk.bytes);
        this.storage.kv.set(this.chunkKey(chunk.sessionId, chunk.index), encoded);
        meta.chunkCount = chunk.index + 1;
        meta.eventCount = chunk.lastSequence;
        meta.lastTick = chunk.endTick;
        meta.storedBytes += encoded.length;
        this.writeMeta(meta);
    }

    onSessionEnd(end: TraceSessionEnd) {
        if (!this.activeSessions.has(end.sessionId)) return;
        try {
            const meta = this.requireMeta(end.sessionId);
            // A failed chunk write must not become a completed recording
            // just because TraceSession emitted a footer. Preserve the real
            // stored counts; no end metadata means read()/toBytes() must reject.
            const complete = meta.chunkCount === end.chunkCount
                && meta.eventCount === end.eventCount;
            meta.status = complete ? end.status : "interrupted";
            meta.end = complete ? end : undefined;
            meta.lastTick = end.endTick;
            this.writeMeta(meta);
            if (!complete) this.report(new Error(
                `Incomplete Trace storage for ${end.sessionId}: stored ${meta.chunkCount}/${end.chunkCount} chunks, ${meta.eventCount}/${end.eventCount} events`
            ));
        } finally {
            this.activeSessions.delete(end.sessionId);
        }
        this.safeMaintenance(() => this.cleanup());
    }

    /** Newest sessions first. Corrupt metadata is skipped and reported. */
    list(): StoredTraceSummary[] {
        const summaries: StoredTraceSummary[] = [];
        for (const id of this.storage.kv.keys()) {
            if (!id.startsWith(STORE_PREFIX) || !id.endsWith(".meta")) continue;
            try {
                const meta = this.readMetaKey(id);
                if (!meta) continue;
                summaries.push(this.toSummary(meta));
            } catch (error) {
                this.report(error);
            }
        }
        summaries.sort(
            (a, b) =>
                b.startWallTime - a.startWallTime ||
                b.sessionId.localeCompare(a.sessionId)
        );
        return summaries;
    }

    latest(): StoredTraceSummary | undefined {
        return this.list().find((entry) => entry.status !== "running");
    }

    /** Return a completed/interrupted session in container-ready form. */
    read(sessionId: string): BegTraceContainer | undefined {
        const meta = this.readMeta(sessionId);
        if (!meta?.end) return undefined;
        const chunks: Uint8Array[] = [];
        for (let index = 0; index < meta.chunkCount; index++) {
            const encoded = this.storage.kv.get(this.chunkKey(sessionId, index));
            if (typeof encoded !== "string") {
                throw new Error(`Missing Trace chunk ${sessionId}:${index}`);
            }
            chunks.push(decodeBase64(encoded));
        }
        return { header: meta.header, chunks, end: meta.end };
    }

    toBytes(sessionId: string): Uint8Array {
        const stored = this.read(sessionId);
        if (!stored) {
            throw new Error(`Stored Trace Session is not complete: ${sessionId}`);
        }
        return encodeBegTrace(
            stored.header,
            stored.chunks.map((bytes) => ({ bytes })),
            stored.end
        );
    }

    /** Container snapshot for inspection; a running session gets a synthetic footer. */
    toSnapshotBytes(sessionId: string): Uint8Array {
        const meta = this.readMeta(sessionId);
        if (!meta) throw new Error(`Stored Trace Session not found: ${sessionId}`);
        const chunks: { bytes: Uint8Array }[] = [];
        for (let index = 0; index < meta.chunkCount; index++) {
            const encoded = this.storage.kv.get(this.chunkKey(sessionId, index));
            if (typeof encoded !== "string") throw new Error(`Missing Trace chunk ${sessionId}:${index}`);
            chunks.push({ bytes: decodeBase64(encoded) });
        }
        const end: TraceSessionEnd = meta.end ?? {
            sessionId,
            status: "interrupted",
            endTick: meta.lastTick,
            endWallTime: Date.now(),
            endReason: "live-snapshot",
            eventCount: meta.eventCount,
            chunkCount: meta.chunkCount,
        };
        return encodeBegTrace(meta.header, chunks, end);
    }

    delete(sessionId: string): boolean {
        if (this.activeSessions.has(sessionId)) return false;
        const prefix = `${STORE_PREFIX}${sessionId}.`;
        let removed = false;
        for (const id of this.storage.kv.keys()) {
            if (!id.startsWith(prefix)) continue;
            this.storage.kv.set(id, undefined);
            removed = true;
        }
        return removed;
    }

    /** Apply age, count and approximate payload-size retention limits. */
    cleanup(): string[] {
        const removed: string[] = [];
        const now = Date.now();

        let completed = this.list().filter(
            (entry) =>
                entry.status !== "running" &&
                !this.activeSessions.has(entry.sessionId)
        );

        for (const entry of completed) {
            const timestamp = entry.endWallTime ?? entry.startWallTime;
            if (now - timestamp <= this.options.maxAgeMs) continue;
            if (this.delete(entry.sessionId)) removed.push(entry.sessionId);
        }

        completed = this.list().filter(
            (entry) =>
                entry.status !== "running" &&
                !this.activeSessions.has(entry.sessionId)
        );
        for (const entry of completed.slice(this.options.maxSessions)) {
            if (this.delete(entry.sessionId)) removed.push(entry.sessionId);
        }

        completed = this.list().filter(
            (entry) =>
                entry.status !== "running" &&
                !this.activeSessions.has(entry.sessionId)
        );
        let totalBytes = completed.reduce(
            (sum, entry) => sum + entry.storedBytes,
            0
        );
        for (let index = completed.length - 1; index >= 0; index--) {
            if (totalBytes <= this.options.maxBytes) break;
            const entry = completed[index];
            if (this.delete(entry.sessionId)) {
                totalBytes -= entry.storedBytes;
                removed.push(entry.sessionId);
            }
        }

        return [...new Set(removed)];
    }

    private recoverInterruptedSessions() {
        for (const summary of this.list()) {
            if (
                summary.status !== "running" ||
                this.activeSessions.has(summary.sessionId)
            ) {
                continue;
            }
            const meta = this.readMeta(summary.sessionId);
            if (!meta) continue;
            const end: TraceSessionEnd = {
                sessionId: summary.sessionId,
                status: "interrupted",
                endTick: meta.lastTick,
                endWallTime: Date.now(),
                endReason: "runtime-recovered",
                eventCount: meta.eventCount,
                chunkCount: meta.chunkCount,
            };
            meta.status = "interrupted";
            meta.end = end;
            this.writeMeta(meta);
        }
    }

    private scheduleMaintenance() {
        if (!this._enabled) return;
        if (this.storage.gate.isReady()) {
            this.runMaintenance();
            return;
        }
        if (this.cancelMaintenanceWait) return;
        this.cancelMaintenanceWait = this.storage.gate.afterReady(() => {
            this.cancelMaintenanceWait = undefined;
            if (!this._enabled) return;
            this.runMaintenance();
        });
    }

    private runMaintenance() {
        if (this.recoverOnMaintenance) {
            this.recoverOnMaintenance = false;
            this.safeMaintenance(() => this.recoverInterruptedSessions());
        }
        this.safeMaintenance(() => this.cleanup());
        this.startCleanupTimer();
    }

    private startCleanupTimer() {
        if (
            !this._enabled ||
            !this.storage.gate.isReady() ||
            this.cleanupRunId !== undefined
        ) {
            return;
        }
        this.cleanupRunId = this.storage.scheduler.every(
            this.options.cleanupIntervalTicks,
            () => this.safeMaintenance(() => this.cleanup())
        );
    }

    private stopCleanupTimer() {
        if (this.cleanupRunId === undefined) return;
        this.storage.scheduler.cancel(this.cleanupRunId);
        this.cleanupRunId = undefined;
    }

    private metaKey(sessionId: string) {
        return `${STORE_PREFIX}${sessionId}.meta`;
    }

    private chunkKey(sessionId: string, index: number) {
        return `${STORE_PREFIX}${sessionId}.${index}`;
    }

    private writeMeta(meta: TraceHistoryMetaV1) {
        this.storage.kv.set(this.metaKey(meta.header.sessionId), JSON.stringify(meta));
    }

    private readMeta(sessionId: string) {
        return this.readMetaKey(this.metaKey(sessionId));
    }

    private requireMeta(sessionId: string) {
        const meta = this.readMeta(sessionId);
        if (!meta) throw new Error(`Missing Trace metadata: ${sessionId}`);
        return meta;
    }

    private readMetaKey(key: string): TraceHistoryMetaV1 | undefined {
        const value = this.storage.kv.get(key);
        if (value === undefined) return undefined;
        if (typeof value !== "string") {
            throw new TypeError(`Invalid Trace metadata property: ${key}`);
        }
        const parsed = JSON.parse(value) as Partial<TraceHistoryMetaV1>;
        if (
            parsed.storageVersion !== 1 ||
            !parsed.header ||
            typeof parsed.header.sessionId !== "string" ||
            typeof parsed.status !== "string" ||
            typeof parsed.chunkCount !== "number" ||
            typeof parsed.eventCount !== "number" ||
            typeof parsed.lastTick !== "number"
        ) {
            throw new TypeError(`Invalid Trace metadata: ${key}`);
        }
        return {
            storageVersion: 1,
            header: parsed.header,
            status: parsed.status as TraceSessionStatus,
            chunkCount: parsed.chunkCount,
            eventCount: parsed.eventCount,
            lastTick: parsed.lastTick,
            storedBytes:
                typeof parsed.storedBytes === "number" ? parsed.storedBytes : 0,
            ...(parsed.end ? { end: parsed.end } : {}),
        };
    }

    private toSummary(meta: TraceHistoryMetaV1): StoredTraceSummary {
        return {
            sessionId: meta.header.sessionId,
            gameType: meta.header.gameType,
            gameKey: meta.header.gameKey,
            status: meta.status,
            startTick: meta.header.startTick,
            startWallTime: meta.header.startWallTime,
            ...(meta.end
                ? {
                      endTick: meta.end.endTick,
                      endWallTime: meta.end.endWallTime,
                      ...(meta.end.endReason === undefined
                          ? {}
                          : { endReason: meta.end.endReason }),
                  }
                : {}),
            eventCount: meta.eventCount,
            chunkCount: meta.chunkCount,
            storedBytes: meta.storedBytes,
        };
    }

    private safeMaintenance(operation: () => unknown) {
        try {
            operation();
        } catch (error) {
            this.report(error);
        }
    }

    private report(error: unknown) {
        try {
            this.onInternalError?.(error);
        } catch {
            // Storage diagnostics must never affect gameplay.
        }
    }
}

function positiveInteger(value: number, name: string) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer`);
    }
    return value;
}

function positiveNumber(value: number, name: string) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive number`);
    }
    return value;
}
