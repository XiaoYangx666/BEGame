import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import {
    DAEMON_CHILD_ENV,
    DAEMON_LOG_ENV,
    DAEMON_PID_ENV,
    clearDaemonRecord,
    daemonStatus,
    isProcessAlive,
    readDaemonRecord,
    resolveDaemonPaths,
    scanDaemonFlags,
    spawnDaemon,
    stopDaemon,
    writeDaemonRecord,
} from "../packages/observatory/server/daemon.ts";
import { parseServerOptions } from "../packages/observatory/server/options.ts";

/** A temp directory plus cleanup, so a failing test never leaves files behind. */
function tempDir(name) {
    const dir = mkdtempSync(join(tmpdir(), `bgobs-${name}-`));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await delay(25);
    }
    return predicate();
}

test("daemon flags are split out of argv", () => {
    const scanned = scanDaemonFlags(["--net", "--daemon", "--log", "a.log", "--pid-file", "a.pid"]);
    expect(scanned.error).toBeUndefined();
    expect(scanned.rest).toEqual(["--net"]);
    expect(scanned.flags).toMatchObject({ daemon: true, log: "a.log", pidFile: "a.pid" });

    expect(scanDaemonFlags(["--stop"]).flags.control).toBe("stop");
    expect(scanDaemonFlags(["--status"]).flags.control).toBe("status");
    // Nothing but process management is removed.
    expect(scanDaemonFlags(["--connect", "--pack", "ddz"]).rest).toEqual(["--connect", "--pack", "ddz"]);
});

test("a flag without its value is an error, not a silent default", () => {
    expect(scanDaemonFlags(["--log"]).error).toMatch(/需要一个路径/);
    expect(scanDaemonFlags(["--pid-file"]).error).toMatch(/需要一个路径/);
});

test("the server option parser never sees background flags", () => {
    const parsed = parseServerOptions(["--net", "--daemon", "--log", "x.log"], {});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
        expect(parsed.options.net).toBe(true);
        expect(parsed.options.http).toBe(true);
    }

    // `--stop` is stripped too, so it is not reported as an unknown flag.
    expect(parseServerOptions(["--stop"], {}).ok).toBe(true);
    // A malformed background flag still fails, with the background message.
    const bad = parseServerOptions(["--log"], {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/需要一个路径/);
});

test("log and pid paths fall back to the working directory", () => {
    const cwd = "/work";
    expect(resolveDaemonPaths({}, { daemon: false }, cwd)).toEqual({
        logPath: "/work/observatory.log",
        pidFile: "/work/observatory.pid",
    });
    expect(resolveDaemonPaths({}, { daemon: false, log: "sub/a.log" }, cwd).logPath).toBe("/work/sub/a.log");
    // Absolute paths are kept as given, regardless of the working directory.
    expect(resolveDaemonPaths({}, { daemon: false, pidFile: "/run/bgobs.pid" }, cwd).pidFile).toBe(
        "/run/bgobs.pid"
    );
});

test("environment supplies paths only when the command line does not", () => {
    const env = { [DAEMON_LOG_ENV]: "env.log", [DAEMON_PID_ENV]: "env.pid" };
    expect(resolveDaemonPaths(env, { daemon: true }, "/work")).toEqual({
        logPath: "/work/env.log",
        pidFile: "/work/env.pid",
    });
    const flags = { daemon: true, log: "cli.log", pidFile: "cli.pid" };
    expect(resolveDaemonPaths(env, flags, "/work")).toEqual({
        logPath: "/work/cli.log",
        pidFile: "/work/cli.pid",
    });
});

test("a pid file round-trips, and unreadable files read as absent", () => {
    const { dir, cleanup } = tempDir("record");
    try {
        const pidFile = join(dir, "observatory.pid");
        expect(readDaemonRecord(pidFile)).toBeUndefined();

        writeDaemonRecord(pidFile, { pid: 4242, log: "/tmp/o.log", startedAt: "2026-01-01T00:00:00.000Z" });
        expect(readDaemonRecord(pidFile)).toMatchObject({ pid: 4242, log: "/tmp/o.log" });

        // A hand-written plain integer is still understood.
        writeFileSync(pidFile, "777\n");
        expect(readDaemonRecord(pidFile)).toEqual({ pid: 777 });

        writeFileSync(pidFile, "not a pid");
        expect(readDaemonRecord(pidFile)).toBeUndefined();

        clearDaemonRecord(pidFile);
        expect(existsSync(pidFile)).toBe(false);
        // Clearing a missing file is not an error.
        expect(() => clearDaemonRecord(pidFile)).not.toThrow();
    } finally {
        cleanup();
    }
});

test("status distinguishes a live process from a stale pid file", () => {
    const { dir, cleanup } = tempDir("status");
    try {
        const pidFile = join(dir, "observatory.pid");
        expect(daemonStatus(pidFile)).toEqual({ running: false });

        writeDaemonRecord(pidFile, { pid: process.pid });
        expect(daemonStatus(pidFile).running).toBe(true);

        // Dead pids are reported as not running rather than throwing.
        writeDaemonRecord(pidFile, { pid: 2147483646 });
        expect(isProcessAlive(2147483646)).toBe(false);
        expect(daemonStatus(pidFile).running).toBe(false);
    } finally {
        cleanup();
    }
});

test("stop cleans up a stale pid file instead of signalling", () => {
    const { dir, cleanup } = tempDir("stale");
    try {
        const pidFile = join(dir, "observatory.pid");
        expect(stopDaemon(pidFile)).toEqual({ stopped: false });

        writeDaemonRecord(pidFile, { pid: 2147483646 });
        const result = stopDaemon(pidFile);
        expect(result.stopped).toBe(false);
        expect(result.record?.pid).toBe(2147483646);
        expect(existsSync(pidFile)).toBe(false);
    } finally {
        cleanup();
    }
});

test("spawnDaemon starts a detached child that stopDaemon can stop", async () => {
    const { dir, cleanup } = tempDir("spawn");
    let pid;
    try {
        const scriptPath = join(dir, "child.mjs");
        const marker = join(dir, "marker.txt");
        writeFileSync(
            scriptPath,
            [
                'import { appendFileSync } from "node:fs";',
                "appendFileSync(process.argv[2], `pid=${process.pid}\\n`);",
                // Stay alive until signalled, like a server would.
                "setInterval(() => {}, 1000);",
            ].join("\n")
        );

        const logPath = join(dir, "observatory.log");
        const pidFile = join(dir, "observatory.pid");
        const spawned = spawnDaemon({
            scriptPath,
            args: [marker],
            logPath,
            pidFile,
            cwd: dir,
        });

        pid = spawned.pid;
        expect(spawned.pid).toBeGreaterThan(0);
        expect(readDaemonRecord(pidFile)?.pid).toBe(spawned.pid);

        expect(await waitFor(() => existsSync(marker))).toBe(true);
        expect(readFileSync(marker, "utf8")).toContain(`pid=${spawned.pid}`);
        expect(daemonStatus(pidFile).running).toBe(true);

        const stopped = stopDaemon(pidFile);
        expect(stopped.stopped).toBe(true);
        expect(stopped.record?.pid).toBe(spawned.pid);
        expect(existsSync(pidFile)).toBe(false);

        expect(await waitFor(() => !isProcessAlive(spawned.pid))).toBe(true);
        pid = undefined;
    } finally {
        if (pid !== undefined) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // Already gone.
            }
        }
        cleanup();
    }
});

test("the child marker keeps a detached process from forking again", () => {
    // The flag is what stops a recursive fork; keep it stable and explicit.
    expect(DAEMON_CHILD_ENV).toBe("BEGAME_OBSERVATORY_CHILD");
});
