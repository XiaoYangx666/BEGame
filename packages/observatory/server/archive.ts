/**
 * On-disk archive of completed Trace Sessions pulled from the live bridges.
 *
 * The `/connect` and BDS trace-net bridges only *proxy* the game's history
 * store: the sessions themselves live in the running game, so a disconnect (or
 * a game restart) erases them from the workbench. This store mirrors finished
 * sessions onto the Observatory's own disk, so the workbench keeps listing and
 * serving them with nothing connected.
 *
 * `Archiver` is the puller; it periodically asks each configured source for its
 * session list and downloads anything finished that is not archived yet. The
 * game-side storage switch is irrelevant here: any session the bridge can list
 * can be archived, whether or not it is persisted inside Minecraft.
 */
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type ArchiveKind = "connect" | "net";

/** Same id alphabet the HTTP surface accepts (`ID_PATTERN` in `app.ts`). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * Filesystem-safe stand-in for a pack id. Pack ids (`packId` handshake values,
 * command namespaces) are arbitrary strings, so they cannot be used as a path
 * segment directly. The original value is kept in the meta JSON, which is what
 * listings and reads key on.
 */
function safeSegment(value: string): string {
    const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
    return cleaned.length > 0 ? cleaned : "_";
}

/** The subset of a session summary the workbench needs to list and open it. */
export interface ArchiveSession {
    readonly sessionId: string;
    readonly gameType?: string;
    readonly gameKey?: string;
    readonly status?: string;
    readonly startTick?: number;
    readonly startWallTime?: number;
    readonly endTick?: number;
    readonly endWallTime?: number;
    readonly endReason?: string;
    readonly eventCount?: number;
    readonly chunkCount?: number;
    readonly storedBytes?: number;
}

/** One archived session plus the source it came from. */
export interface ArchiveRecord {
    readonly kind: ArchiveKind;
    readonly pack: string;
    readonly packName?: string;
    readonly session: ArchiveSession;
    readonly storedAt: number;
}

const STRING_FIELDS = ["gameType", "gameKey", "status", "endReason"] as const;
const NUMBER_FIELDS = [
    "startTick",
    "startWallTime",
    "endTick",
    "endWallTime",
    "eventCount",
    "chunkCount",
] as const;

/** Keeps only the known fields, so a stray live summary never bloats the meta. */
function normalizeSession(raw: ArchiveSession, bytes: number): ArchiveSession {
    const out: Record<string, unknown> = { sessionId: raw.sessionId };
    for (const key of STRING_FIELDS) {
        const value = raw[key];
        if (typeof value === "string") out[key] = value;
    }
    for (const key of NUMBER_FIELDS) {
        const value = raw[key];
        if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    out.storedBytes =
        typeof raw.storedBytes === "number" && Number.isFinite(raw.storedBytes)
            ? raw.storedBytes
            : bytes;
    return out as unknown as ArchiveSession;
}

function directories(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch {
        return [];
    }
}

function toRecord(raw: unknown, fallbackKind: ArchiveKind): ArchiveRecord | undefined {
    if (raw === null || typeof raw !== "object") return undefined;
    const value = raw as Record<string, unknown>;
    const pack = value.pack;
    if (typeof pack !== "string" || pack.length === 0) return undefined;
    const session = value.session;
    if (session === null || typeof session !== "object") return undefined;
    const sessionId = (session as Record<string, unknown>).sessionId;
    if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) return undefined;
    const kind = value.kind === "connect" || value.kind === "net" ? value.kind : fallbackKind;
    return {
        kind,
        pack,
        ...(typeof value.packName === "string" ? { packName: value.packName } : {}),
        session: session as ArchiveSession,
        storedAt: typeof value.storedAt === "number" ? value.storedAt : 0,
    };
}

/**
 * Disk layout: `<dir>/<kind>/<safe pack>/<sessionId>.begtrace` plus a sibling
 * `.json` carrying the source label and summary. The trace is renamed into
 * place before the meta is written, so a listed record always has complete
 * bytes.
 */
export class ArchiveStore {
    constructor(private readonly dir: string) {
        mkdirSync(dir, { recursive: true });
    }

    get directory(): string {
        return this.dir;
    }

    save(
        kind: ArchiveKind,
        pack: string,
        packName: string | undefined,
        session: ArchiveSession,
        bytes: Uint8Array | Buffer
    ): ArchiveRecord {
        if (!session || !ID_PATTERN.test(session.sessionId)) {
            throw new Error(`无效的归档会话 ID：${session?.sessionId}`);
        }
        const sourceDir = this.sourceDir(kind, pack);
        mkdirSync(sourceDir, { recursive: true });
        const tracePath = join(sourceDir, `${session.sessionId}.begtrace`);
        const tempPath = `${tracePath}.tmp`;
        writeFileSync(tempPath, bytes);
        renameSync(tempPath, tracePath);
        const record: ArchiveRecord = {
            kind,
            pack,
            ...(packName ? { packName } : {}),
            session: normalizeSession(session, bytes.length),
            storedAt: Date.now(),
        };
        writeFileSync(join(sourceDir, `${session.sessionId}.json`), JSON.stringify(record));
        return record;
    }

    has(kind: ArchiveKind, pack: string, sessionId: string): boolean {
        if (!ID_PATTERN.test(sessionId)) return false;
        return existsSync(this.tracePath(kind, pack, sessionId));
    }

    read(kind: ArchiveKind, pack: string, sessionId: string): Buffer | undefined {
        if (!ID_PATTERN.test(sessionId)) return undefined;
        try {
            return readFileSync(this.tracePath(kind, pack, sessionId));
        } catch {
            return undefined;
        }
    }

    remove(kind: ArchiveKind, pack: string, sessionId: string): boolean {
        if (!ID_PATTERN.test(sessionId)) return false;
        const tracePath = this.tracePath(kind, pack, sessionId);
        if (!existsSync(tracePath)) return false;
        rmSync(tracePath, { force: true });
        rmSync(join(this.sourceDir(kind, pack), `${sessionId}.json`), { force: true });
        return true;
    }

    /** Drops every archived session of one source; returns how many traces went. */
    clear(kind: ArchiveKind, pack: string): number {
        const sourceDir = this.sourceDir(kind, pack);
        if (!existsSync(sourceDir)) return 0;
        let removed = 0;
        for (const name of readdirSync(sourceDir)) {
            if (name.endsWith(".begtrace")) removed++;
        }
        rmSync(sourceDir, { recursive: true, force: true });
        return removed;
    }

    /** Newest first. A record whose trace went missing is skipped. */
    list(): ArchiveRecord[] {
        const records: ArchiveRecord[] = [];
        for (const kind of directories(this.dir)) {
            if (kind !== "connect" && kind !== "net") continue;
            const kindDir = join(this.dir, kind);
            for (const packDir of directories(kindDir)) {
                const sourceDir = join(kindDir, packDir);
                for (const name of readdirSync(sourceDir)) {
                    if (!name.endsWith(".json")) continue;
                    const sessionId = name.slice(0, -".json".length);
                    if (!ID_PATTERN.test(sessionId)) continue;
                    if (!existsSync(join(sourceDir, `${sessionId}.begtrace`))) continue;
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(readFileSync(join(sourceDir, name), "utf8"));
                    } catch {
                        continue;
                    }
                    const record = toRecord(parsed, kind);
                    if (record) records.push(record);
                }
            }
        }
        records.sort(
            (a, b) =>
                (b.session.startWallTime ?? b.storedAt) -
                (a.session.startWallTime ?? a.storedAt)
        );
        return records;
    }

    private sourceDir(kind: ArchiveKind, pack: string): string {
        return join(this.dir, kind, safeSegment(pack));
    }

    private tracePath(kind: ArchiveKind, pack: string, sessionId: string): string {
        return join(this.sourceDir(kind, pack), `${sessionId}.begtrace`);
    }
}

/** One session as reported by a live bridge. */
export interface ArchiveLiveSession {
    readonly sessionId: string;
    readonly status?: string;
    readonly gameType?: string;
    readonly gameKey?: string;
    readonly startTick?: number;
    readonly startWallTime?: number;
    readonly endTick?: number;
    readonly endWallTime?: number;
    readonly endReason?: string;
    readonly eventCount?: number;
    readonly chunkCount?: number;
    readonly storedBytes?: number;
}

/** A pack's live session list, as reported by one bridge. */
export interface ArchiveLiveGroup {
    readonly pack: string;
    readonly packName?: string;
    readonly sessions: readonly ArchiveLiveSession[];
}

/**
 * The slice of a live bridge the archiver needs. Keeping it structural lets the
 * tests drive the archiver with a tiny fake instead of a real socket.
 */
export interface ArchiveSource {
    readonly kind: ArchiveKind;
    list(): Promise<readonly ArchiveLiveGroup[]>;
    download(pack: string, sessionId: string): Promise<Buffer>;
    /**
     * When present and false, the sweep skips this source. Lets a bridge that
     * throws (rather than returning empty) while offline stay quiet.
     */
    readonly available?: () => boolean;
}

export interface ArchiverOptions {
    /** How often to poll the sources. Defaults to 3000 ms. */
    readonly intervalMs?: number;
    /**
     * Cap on sessions downloaded per poll. The `/connect` bridge serializes
     * every command behind one queue, so a full backfill must be spread out or
     * it would starve the workbench's own refreshes.
     */
    readonly maxPerSweep?: number;
    /** Receives per-session delivery failures. Defaults to a silent no-op. */
    readonly onError?: (error: unknown) => void;
}

/** Pulls completed sessions from live bridges into an {@link ArchiveStore}. */
export class Archiver {
    private timer?: ReturnType<typeof setInterval>;
    private sweeping = false;
    private stopped = true;
    private readonly inflight = new Set<string>();
    private readonly intervalMs: number;
    private readonly maxPerSweep: number;
    private readonly report: (error: unknown) => void;

    constructor(
        private readonly archive: ArchiveStore,
        private readonly sources: readonly ArchiveSource[],
        options: ArchiverOptions = {}
    ) {
        this.intervalMs = Math.max(250, options.intervalMs ?? 3000);
        this.maxPerSweep = Math.max(1, options.maxPerSweep ?? 5);
        this.report = options.onError ?? (() => {});
    }

    get running(): boolean {
        return !this.stopped;
    }

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        void this.sweep();
        this.timer = setInterval(() => void this.sweep(), this.intervalMs);
        // The archiver must never hold the process open on its own.
        this.timer.unref?.();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * One pass over every source. Re-entrant calls return immediately so a slow
     * download cannot pile up timers; returns the number of sessions saved.
     */
    async sweep(): Promise<number> {
        if (this.sweeping) return 0;
        this.sweeping = true;
        let saved = 0;
        try {
            for (const source of this.sources) {
                if (saved >= this.maxPerSweep) break;
                if (source.available && !source.available()) continue;
                let groups: readonly ArchiveLiveGroup[];
                try {
                    groups = await source.list();
                } catch (error) {
                    this.report(error);
                    continue;
                }
                for (const group of groups) {
                    if (saved >= this.maxPerSweep) break;
                    for (const session of group.sessions) {
                        if (saved >= this.maxPerSweep) break;
                        // A running session has no footer yet; archiving it now
                        // would freeze a partial trace. It is picked up later,
                        // once the run finishes and the status changes.
                        if (!session?.sessionId || session.status === "running") continue;
                        if (this.archive.has(source.kind, group.pack, session.sessionId)) {
                            continue;
                        }
                        const key = `${source.kind}\u0000${group.pack}\u0000${session.sessionId}`;
                        if (this.inflight.has(key)) continue;
                        this.inflight.add(key);
                        try {
                            const bytes = await source.download(group.pack, session.sessionId);
                            this.archive.save(
                                source.kind,
                                group.pack,
                                group.packName,
                                session,
                                bytes
                            );
                            saved++;
                        } catch (error) {
                            this.report(error);
                        } finally {
                            this.inflight.delete(key);
                        }
                    }
                }
            }
        } finally {
            this.sweeping = false;
        }
        return saved;
    }
}
