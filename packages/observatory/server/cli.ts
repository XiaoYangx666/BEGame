#!/usr/bin/env node
/**
 * CLI entry for the Observatory.
 *
 * Kept separate from `./server` so the package can expose a `bin` target with a
 * shebang without putting one inside the server module itself (which is also
 * imported by tests and by `main`).
 *
 * This entry also owns background running: `--daemon` detaches a child and
 * exits, `--stop` / `--status` manage that child, and everything else falls
 * through to the server. The detached child re-enters here with
 * `BEGAME_OBSERVATORY_CHILD` set, so it serves instead of forking again.
 */
import { fileURLToPath } from "node:url";
import {
    DAEMON_CHILD_ENV,
    clearDaemonRecord,
    daemonStatus,
    resolveDaemonPaths,
    scanDaemonFlags,
    spawnDaemon,
    stopDaemon,
} from "./daemon";

const argv = process.argv.slice(2);
const { flags, error } = scanDaemonFlags(argv);
const paths = resolveDaemonPaths(process.env, flags, process.cwd());

if (error !== undefined) {
    console.error(error);
    process.exitCode = 2;
} else if (flags.control === "status") {
    const status = daemonStatus(paths.pidFile);
    if (status.running && status.record) {
        console.log(`Observatory 正在运行：pid ${status.record.pid}`);
        if (status.record.startedAt) console.log(`  启动时间：${status.record.startedAt}`);
        if (status.record.log) console.log(`  日志：${status.record.log}`);
        console.log(`  pid 文件：${paths.pidFile}`);
    } else {
        // A pid file left behind by a crash is reported once and cleaned up, so
        // the next `--status` is not misleading.
        if (status.record) clearDaemonRecord(paths.pidFile);
        console.log("Observatory 未在后台运行。");
        process.exitCode = 1;
    }
} else if (flags.control === "stop") {
    const result = stopDaemon(paths.pidFile);
    if (result.stopped && result.record) {
        console.log(`已发送停止信号：pid ${result.record.pid}`);
    } else {
        console.log("Observatory 未在后台运行。");
        process.exitCode = 1;
    }
} else if (flags.daemon && process.env[DAEMON_CHILD_ENV] !== "1") {
    const running = daemonStatus(paths.pidFile);
    if (running.running && running.record) {
        console.error(
            `Observatory 已在后台运行：pid ${running.record.pid}（用 --status 查看，--stop 停止）`
        );
        process.exitCode = 1;
    } else {
        const record = spawnDaemon({
            // argv[1] of the child is this very file, so the child re-runs the
            // same entry (and the same `--daemon` flag, which it then ignores).
            scriptPath: fileURLToPath(import.meta.url),
            args: argv,
            logPath: paths.logPath,
            pidFile: paths.pidFile,
            cwd: process.cwd(),
        });
        console.log(`Observatory 已在后台启动：pid ${record.pid}`);
        console.log(`  日志：${paths.logPath}`);
        console.log(`  查看状态：--status    停止：--stop`);
    }
} else {
    await import("./index");
}
