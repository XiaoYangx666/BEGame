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
/**
 * Bounded tombstones keep deletions available to incremental pollers. Once a
 * tombstone is dropped, a client that is further behind must take a full list;
 * otherwise it could keep a session that no longer exists.
 */
const DEFAULT_TOMBSTONE_LIMIT = 256;

/** Result of {@link TraceHistoryStore.listSince}. */
export interface TraceListingDelta {
    /** True when the caller cannot be served incrementally. */
    readonly full: boolean;
    readonly sessions: StoredTraceSummary[];
    /** Sessions deleted after the caller's revision, newest change wins. */
    readonly removed: string[];
    readonly revision: number;
}

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
    /**
     * Listing snapshots are rebuilt only after a store write. Consumers such as
     * the Observatory poll `list()` while idle, and every rebuild reads one
     * dynamic property per stored session.
     */
    private listing?: StoredTraceSummary[];
    /**
     * Monotonic listing revision. Bumped only when {@link listing} is
     * invalidated, so a remote poller can prove its cached copy is current
     * without transferring every summary again.
     */
    private _revision = 0;
    /**
     * Last write revision per current session. A poller only needs a session's
     * latest summary, so one entry replaces a change log.
     */
    private readonly sessionRevisions = new Map<string, number>();
    /**
     * Deletions retained for incremental pollers. `_tombstoneFloor` is the
     * newest dropped tombstone revision; older callers must take a full list.
     */
    private readonly tombstones = new Map<string, number>();
    private _tombstoneFloor = 0;

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

    /** Monotonic revision of the current listing snapshot. */
    get revision() {
        return this._revision;
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
            meta.status = end.status;
            meta.end = end;
            meta.chunkCount = end.chunkCount;
            meta.eventCount = end.eventCount;
            meta.lastTick = end.endTick;
            this.writeMeta(meta);
        } finally {
            this.activeSessions.delete(end.sessionId);
        }
        this.safeMaintenance(() => this.cleanup());
    }

    /** Newest sessions first. Corrupt metadata is skipped and reported. */
    list(): StoredTraceSummary[] {
        if (this.listing) return [...this.listing];
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
        this.listing = summaries;
        return [...summaries];
    }

    /**
     * Incremental view for a caller that already has the listing at `since`.
     *
     * A full listing is returned on the first poll, when the caller is ahead of
     * this store (for example after a script reload), or when a dropped
     * tombstone means deletions can no longer be reconstructed. Otherwise only
     * sessions changed after `since` are returned; a session written and then
     * deleted appears only in `removed`.
     */
    listSince(since: number | undefined): TraceListingDelta {
        const revision = this._revision;
        if (since === undefined || since > revision || since < this._tombstoneFloor) {
            return { full: true, sessions: this.list(), removed: [], revision };
        }
        if (since === revision) {
            return { full: false, sessions: [], removed: [], revision };
        }

        // A session's latest write revision is enough to decide whether the
        // caller already has it. Only materialize the cached listing when at
        // least one session actually changed; delete-only deltas stay cheap.
        const upserts = new Set<string>();
        for (const [sessionId, updatedAt] of this.sessionRevisions) {
            if (updatedAt > since) upserts.add(sessionId);
        }
        const sessions =
            upserts.size === 0
                ? []
                : this.list().filter((entry) => upserts.has(entry.sessionId));
        const removed: string[] = [];
        for (const [sessionId, deletedAt] of this.tombstones) {
            if (deletedAt > since) removed.push(sessionId);
        }
        return { full: false, sessions, removed, revision };
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
        if (removed) this.invalidateListing("delete", sessionId);
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
        this.invalidateListing("upsert", meta.header.sessionId);
    }

    private invalidateListing(type: "upsert" | "delete", sessionId: string) {
        this.listing = undefined;
        const revision = ++this._revision;

        if (type === "upsert") {
            this.sessionRevisions.set(sessionId, revision);
            // A recreated session must not also be reported as removed.
            this.tombstones.delete(sessionId);
            return;
        }

        this.sessionRevisions.delete(sessionId);
        this.tombstones.set(sessionId, revision);
        this.pruneTombstones();
    }

    private pruneTombstones() {
        while (this.tombstones.size > DEFAULT_TOMBSTONE_LIMIT) {
            const oldest = this.tombstones.keys().next().value;
            if (oldest === undefined) return;
            const droppedRevision = this.tombstones.get(oldest);
            this.tombstones.delete(oldest);
            if (droppedRevision !== undefined && droppedRevision > this._tombstoneFloor) {
                this._tombstoneFloor = droppedRevision;
            }
        }
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
