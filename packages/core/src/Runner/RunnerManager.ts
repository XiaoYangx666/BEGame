import { system } from "@minecraft/server";
import { Logger } from "@begame/core/utils";
import {
    BuiltinTraceEventType,
    traceErrorValue,
    type TraceScope,
} from "../trace/contract";
import { ScriptRunner } from "./scriptRunner";

export class RunnerManager {
    private runners = new Map<
        string,
        ScriptRunner | { runId: number; settle: () => void }
    >();
    private idCounter = 0;
    private readonly logger: Logger;

    constructor(
        stateName: string,
        private readonly trace?: TraceScope
    ) {
        this.logger = new Logger(stateName + "-runner");
    }

    /**返回一个新的scriptRunner(需手动捕获错误) */
    new() {
        const id = `runner-${++this.idCounter}`;
        const runner = new ScriptRunner(id, (finishedId) => {
            this.runners.delete(finishedId);
        });

        this.runners.set(id, runner);
        return { id: id, runner: runner };
    }

    /**运行普通脚本 */
    run(script: (runner: ScriptRunner) => Promise<void> | void): string {
        const { id, runner } = this.new();

        runner.run(script).catch((e) => {
            this.trace?.builtin(BuiltinTraceEventType.RunnerUncaughtError, {
                runnerId: id,
                error: traceErrorValue(e),
            });
            this.logger.error(`runner ${id} 出错了:`, e);
        });
        return id;
    }

    runDelay(
        script: (runner: ScriptRunner) => Promise<void> | void,
        ticks: number
    ): string {
        const { id, runner } = this.new();

        runner
            .run(async (r) => {
                await r.wait(ticks);
                await script(r);
            })
            .catch((e) => {
                this.trace?.builtin(BuiltinTraceEventType.RunnerUncaughtError, {
                    runnerId: id,
                    error: traceErrorValue(e),
                });
                this.logger.error(`runner ${id} 出错了:`, e);
            });

        return id;
    }

    /**使用游戏 runJob 运行 generator */
    runJob(generator: Generator<void, void, void>): {
        id: string;
        promise: Promise<void>;
    } {
        const id = `runner-${++this.idCounter}`;
        const wrapped = wrapGeneratorWithPromise(generator);
        const runId = system.runJob(wrapped.gen);

        // `settle` must be kept alongside the job id: clearJob() abandons the
        // generator without resuming it, so without an explicit settlement the
        // wrapper promise would stay pending forever and its `.finally` — the
        // only code that removes this entry — would never run.
        this.runners.set(id, { runId, settle: wrapped.settle });
        const promise = wrapped.promise
            .catch((error) => {
                this.trace?.builtin(BuiltinTraceEventType.RunnerUncaughtError, {
                    runnerId: id,
                    error: traceErrorValue(error),
                });
                throw error;
            })
            .finally(() => {
                this.runners.delete(id);
            });
        return { id, promise };
    }

    /**取消指定 runner 或 job */
    cancel(id: string, reason = "cancel"): boolean {
        const entry = this.runners.get(id);
        if (!entry) return false;

        if (entry instanceof ScriptRunner) {
            entry.cancel();
        } else {
            system.clearJob(entry.runId);
            // Cancellation is a normal outcome, not a failure: settle as resolved
            // so no unhandled rejection surfaces and the entry is released now.
            entry.settle();
        }

        this.runners.delete(id);
        this.trace?.builtin(BuiltinTraceEventType.RunnerCancelled, {
            runnerId: id,
            reason,
        });
        return true;
    }

    /**取消所有 runner/job */
    dispose() {
        for (const [id, entry] of this.runners) {
            if (entry instanceof ScriptRunner) {
                entry.cancel();
            } else {
                system.clearJob(entry.runId);
                entry.settle();
            }
            this.trace?.builtin(BuiltinTraceEventType.RunnerCancelled, {
                runnerId: id,
                reason: "state-dispose",
            });
        }
        this.runners.clear();
    }

    get size(): number {
        return this.runners.size;
    }
}

function wrapGeneratorWithPromise(gen: Generator<void, void, void>): {
    gen: Generator<void, void, void>;
    promise: Promise<void>;
    settle: () => void;
} {
    let resolveFn!: () => void;
    let rejectFn!: (err: any) => void;
    /** Settlement is single-shot; later generator completion must be a no-op. */
    let settled = false;

    const promise = new Promise<void>((resolve, reject) => {
        resolveFn = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        rejectFn = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };
    });

    function* wrapper() {
        try {
            let next = gen.next();
            while (!next.done) {
                yield;
                if (settled) return;
                next = gen.next();
            }
            resolveFn();
        } catch (err) {
            rejectFn(err);
        }
    }

    return { gen: wrapper(), promise, settle: resolveFn };
}
