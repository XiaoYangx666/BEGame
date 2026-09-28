import { BEGameConfig, BEGameConfigOptions } from "./config";
import { Constants } from "./constants";
import { gameEvents } from "./gameEvent/gameEvent";
import { ParticipationPolicy } from "./participation/participationManager";
import { GameManager } from "./system/gameManager";
import { gameServer } from "./system/server";
import type { TraceRuntime } from "./trace/contract";
import { Logger } from "./utils/logger";
import type { TraceStoreOptions } from "@begame/trace-spec";

export { BEGameConfig, SAPIGameConfig } from "./config";
export type { BEGameConfigOptions, SAPIGameConfigOptions } from "./config";

/**
 * The trace contract types.
 *
 * `@begame/core` ships no trace implementation, so these are the only trace
 * names it exposes — and they are type-only, which means they are erased at
 * build time and cost nothing in the bundle. They exist so gameplay code can
 * name the scope it hands around (`TraceScope`, the type of `this.trace` on
 * engines, states and components) from the package root instead of reaching into
 * a subpath.
 */
export type {
    TraceConnectionSource,
    TraceRuntime,
    TraceScope,
    TraceSession,
    TraceStoreLike,
} from "./trace/contract";

export interface BEGameTraceStoreInitOptions extends TraceStoreOptions {
    /** Whether World Dynamic Property history storage is enabled. Defaults to true when this object is provided. */
    enabled?: boolean;
}

export interface BEGameInitOptions extends BEGameConfigOptions {
    participationPolicy?: ParticipationPolicy;
    /**
     * The trace runtime to use, built by `@begame/trace`.
     *
     * `@begame/core` does not depend on the trace implementation, so tracing is
     * wired here rather than switched on by an option. Omit it and the inert
     * runtime is used and no trace code is bundled.
     */
    trace?: TraceRuntime;
    /**
     * Persistent Game Trace history in World Dynamic Properties.
     * Omit to leave the current runtime setting unchanged; boolean toggles storage,
     * or provide retention options plus `enabled`.
     */
    traceStore?: boolean | BEGameTraceStoreInitOptions;
}

/** @deprecated 使用 BEGameInitOptions。 */
export type SAPIGameInitOptions = BEGameInitOptions;

const manager = new GameManager();
const events = new gameEvents();
// Recorded, not bound: no trace runtime exists yet during module evaluation.
manager.bindTraceConnectionSource(events.connection);

/** BEGame 核心全局入口。命令/onJoin 等服务器集成能力仍需显式启用 `@begame/core/server`。 */
export const Game = {
    events,
    server: gameServer,
    manager,
    participation: manager.participation,
    // Must stay a getter: reading it here would capture the inert runtime while
    // this module is still evaluating, before anything could inject the real one.
    get trace() {
        return manager.trace;
    },
    constants: Constants,
    config: BEGameConfig,
    /**
     * Injects the trace runtime outside of `initBEGame`.
     *
     * Equivalent to `initBEGame({ trace })`; useful for composition roots that
     * configure the runtime themselves (the headless test engine does this).
     */
    attachTrace(runtime?: TraceRuntime) {
        manager.attachTrace(runtime);
    },
} as const;

/** 初始化 BEGame Core；不会注册服务器命令或玩家轮询。 */
export function initBEGame(options: BEGameInitOptions = {}) {
    const { participationPolicy, traceStore, trace, ...config } = options;
    BEGameConfig.update(config);
    if (participationPolicy) {
        manager.participation.setPolicy(participationPolicy);
    }
    if (trace) {
        manager.attachTrace(trace);
    }
    if (traceStore !== undefined) {
        const wantsTrace =
            typeof traceStore === "boolean"
                ? traceStore
                : traceStore.enabled !== false;
        if (wantsTrace && !manager.hasTraceRuntime()) {
            // Otherwise this silently records nothing, and the missing history
            // looks like a framework bug rather than a missing injection.
            new Logger("BEGame").error(
                "traceStore 已启用，但没有注入 Trace 运行时。" +
                    '请 import { createTraceRuntime } from "@begame/trace" 并传给 initBEGame({ trace })。'
            );
        }
        if (typeof traceStore === "boolean") {
            manager.trace.setStoreEnabled(traceStore);
        } else {
            const { enabled = true, ...storeOptions } = traceStore;
            manager.trace.configureStore(storeOptions);
            manager.trace.setStoreEnabled(enabled);
        }
    }
}

/** @deprecated 使用 initBEGame。 */
export const initSAPIGame = initBEGame;

export * from "./gameRegion/index";
export * as Utils from "./utils/index";
export * from "./gameComponent/index";
export * from "./gameState/index";
export * from "./gamePlayer/index";
export * from "./participation/participationManager";
export { GameEngine } from "./gameEngine";
export type { GameEngineOwner } from "./gameEngine";
export { GameContext } from "./gameContext";
export { GameStructure } from "./gameStructure/gameStructure";
export * from "./gameStructure/structureBlockMask";
export { ScriptRunner, ScriptCancelledError } from "./Runner/scriptRunner";
export { RunnerManager } from "./Runner/RunnerManager";
export * from "./gameEvent/index";
export * from "./system/gameManager";
export { createGameModule } from "./createGameModule";
