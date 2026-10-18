/**
 * Background ("daemon") support for the Observatory CLI.
 *
 * The BDS trace bridge only pushes while the Observatory is listening, and the
 * game side gives up after a bounded number of failed connects, so the
 * Observatory is normally meant to stay up across terminal sessions. This
 * module owns exactly that process-level concern: detaching a background child,
 * remembering its pid, and stopping / inspecting it again.
 *
 * It deliberately knows nothing about servers, bridges or trace data. The CLI
 * entry decides whether to daemonize; `./index` keeps serving in the child.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Set on the detached child. Without it, the child would see `--daemon` in its
 * own argv and fork again, forever.
 */
export const DAEMON_CHILD_ENV = "BEGAME_OBSERVATORY_CHILD";

/** Environment variables used when no CLI path is given. */
export const DAEMON_LOG_ENV = "BEGAME_OBSERVATORY_LOG";
export const DAEMON_PID_ENV = "BEGAME_OBSERVATORY_PID_FILE";

const DEFAULT_LOG_NAME = "observatory.log";
const DEFAULT_PID_NAME = "observatory.pid";

/** Process-management flags, split out of the server options. */
export interface DaemonFlags {
    /** Detach and keep running after this process exits. */
    daemon: boolean;
    /** `--stop` / `--status`; mutually exclusive with serving. */
    control?: "stop" | "status";
    /** Raw `--log` value, resolved later against the working directory. */
    log?: string;
    /** Raw `--pid-file` value, resolved later against the working directory. */
    pidFile?: string;
}

export interface ScannedArgs {
    readonly flags: DaemonFlags;
    /** argv with every process-management flag removed. */
    readonly rest: string[];
    /** Set when a flag was given without its value. */
    readonly error?: string;
}

/**
 * Removes the process-management flags from argv, so the server option parser
 * never sees them and stays unaware of background running. Kept here (rather
 * than in `./options`) so the flag names have exactly one definition.
 */
export function scanDaemonFlags(argv: readonly string[]): ScannedArgs {
    const rest: string[] = [];
    const flags: DaemonFlags = { daemon: false };
    let error: string | undefined;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === "--daemon") {
            flags.daemon = true;
            continue;
        }
        if (arg === "--stop" || arg === "--status") {
            flags.control = arg === "--stop" ? "stop" : "status";
            continue;
        }
        if (arg === "--log" || arg === "--pid-file") {
            const value = argv[++index];
            if (value === undefined) {
                error ??= `${arg} 需要一个路径`;
                continue;
            }
            if (arg === "--log") flags.log = value;
            else flags.pidFile = value;
            continue;
        }
        rest.push(arg);
    }

    return error === undefined ? { flags, rest } : { flags, rest, error };
}

export interface DaemonPaths {
    readonly logPath: string;
    readonly pidFile: string;
}

/**
 * Resolves the log and pid locations. Precedence: `--log` / `--pid-file`, then
 * the environment, then `./observatory.log` and `./observatory.pid` next to the
 * working directory. Relative paths are resolved against the working directory
 * rather than the installed package, so a global install stays writable.
 */
export function resolveDaemonPaths(
    env: Record<string, string | undefined>,
    flags: DaemonFlags,
    cwd: string
): DaemonPaths {
    const log = flags.log ?? env[DAEMON_LOG_ENV];
    const pid = flags.pidFile ?? env[DAEMON_PID_ENV];
    return {
        logPath: resolve(cwd, log === undefined || log === "" ? DEFAULT_LOG_NAME : log),
        pidFile: resolve(cwd, pid === undefined || pid === "" ? DEFAULT_PID_NAME : pid),
    };
}

/** What a pid file records about the running process. */
export interface DaemonRecord {
    readonly pid: number;
    readonly log?: string;
    readonly cwd?: string;
    readonly startedAt?: string;
}

/**
 * Reads a pid file. A JSON record is written by {@link spawnDaemon}; a plain
 * integer is accepted too, so a hand-written pid file still works. Anything
 * unreadable or malformed reads as "no process".
 */
export function readDaemonRecord(pidFile: string): DaemonRecord | undefined {
    let text: string;
    try {
        text = readFileSync(pidFile, "utf8").trim();
    } catch {
        return undefined;
    }
    if (text === "") return undefined;
    try {
        const parsed = JSON.parse(text) as Partial<DaemonRecord> | number;
        if (typeof parsed === "number") {
            return Number.isInteger(parsed) && parsed > 0 ? { pid: parsed } : undefined;
        }
        if (typeof parsed?.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
            return {
                pid: parsed.pid,
                ...(typeof parsed.log === "string" ? { log: parsed.log } : {}),
                ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
                ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
            };
        }
    } catch {
        // Fall through to the plain-integer form below.
    }
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
}

/** `EPERM` means the pid exists but belongs to another user, which is alive. */
export function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export interface DaemonStatus {
    readonly running: boolean;
    readonly record?: DaemonRecord;
}

/**
 * Reports whether the recorded process is still alive. A stale pid file reads
 * as "not running" instead of as an error; callers may clean it up.
 */
export function daemonStatus(pidFile: string): DaemonStatus {
    const record = readDaemonRecord(pidFile);
    if (record === undefined) return { running: false };
    return { running: isProcessAlive(record.pid), record };
}

export function writeDaemonRecord(pidFile: string, record: DaemonRecord): void {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, `${JSON.stringify(record, null, 4)}\n`);
}

export function clearDaemonRecord(pidFile: string): void {
    rmSync(pidFile, { force: true });
}

export interface SpawnDaemonOptions {
    /** Script to run in the child; in a built package this is `dist/cli.js`. */
    readonly scriptPath: string;
    /** argv for the child, including the `--daemon` flag it will ignore. */
    readonly args: readonly string[];
    readonly logPath: string;
    readonly pidFile: string;
    readonly cwd: string;
}

/**
 * Starts the Observatory as a detached child whose output goes to `logPath`,
 * then returns once the child is recorded. The child inherits the environment
 * plus {@link DAEMON_CHILD_ENV}, so it serves instead of forking again.
 *
 * The caller decides what to do about an already-running instance; this only
 * starts one.
 */
export function spawnDaemon(options: SpawnDaemonOptions): DaemonRecord {
    mkdirSync(dirname(options.logPath), { recursive: true });
    const log = openSync(options.logPath, "a");
    let child: ReturnType<typeof spawn> | undefined;
    try {
        child = spawn(process.execPath, [options.scriptPath, ...options.args], {
            detached: true,
            // stdin must not be the terminal, or the child would hold it open.
            stdio: ["ignore", log, log],
            cwd: options.cwd,
            env: { ...process.env, [DAEMON_CHILD_ENV]: "1" },
            windowsHide: true,
        });
    } finally {
        closeSync(log);
    }
    if (child?.pid === undefined) throw new Error("后台进程启动失败：没有拿到 pid");

    // Detach from the parent's event loop so the parent can exit immediately.
    child.unref();

    const record: DaemonRecord = {
        pid: child.pid,
        log: options.logPath,
        cwd: options.cwd,
        startedAt: new Date().toISOString(),
    };
    writeDaemonRecord(options.pidFile, record);
    return record;
}

export interface StopResult {
    readonly stopped: boolean;
    readonly record?: DaemonRecord;
}

/**
 * Stops the recorded process with `SIGTERM` and removes its pid file. A stale
 * pid file (process already gone) is cleaned up and reported as not stopped, so
 * the caller can tell the two apart.
 */
export function stopDaemon(pidFile: string): StopResult {
    const record = readDaemonRecord(pidFile);
    if (record === undefined) return { stopped: false };
    if (!isProcessAlive(record.pid)) {
        clearDaemonRecord(pidFile);
        return { stopped: false, record };
    }
    process.kill(record.pid, "SIGTERM");
    clearDaemonRecord(pidFile);
    return { stopped: true, record };
}
