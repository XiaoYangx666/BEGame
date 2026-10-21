import { system } from "@minecraft/server";
import { GameContext } from "./gameContext";
import { PlayerGroup } from "./gamePlayer/playerGroup";
import { PlayerGroupSet } from "./gamePlayer/groupSet";
import type { Subscription } from "./gameEvent/subscription";
import { GamePlayer } from "./gamePlayer/gamePlayer";
import { GamePlayerManager } from "./gamePlayer/playerManager";
import {
    ExtractConfig,
    GameState,
    gameStateConstructor,
} from "./gameState/gameState";
import {
    GameParticipation,
    ParticipationManager,
    type ParticipationChange,
} from "./participation/participationManager";
import {
    BuiltinTraceEventType,
    NOOP_TRACE_SCOPE,
    traceErrorValue,
    type TraceRuntime,
    type TraceScope,
    type TraceSession,
} from "./trace/contract";
import { GameEngineError } from "./utils/GameError";
import { classConstructor } from "./utils/interfaces";
import { Logger } from "./utils/logger";

interface GameStateInternal {
    _onEnter: () => void;
    _onEnterFailed: () => void;
    _onExit: () => void;
}

export type GameLifecycleState =
    | "created"
    | "starting"
    | "running"
    | "stopping"
    | "disposed";

/**GameEngine 的创建者只需要提供停止能力、共享 participation 与 trace 服务。*/
export interface GameEngineOwner {
    readonly participation: ParticipationManager;
    readonly trace: TraceRuntime;
    stopGameByKey(key: string, reason?: string): void;
}

export abstract class GameEngine<
    P extends GamePlayer = any,
    C extends GameContext = any,
    O = unknown
> {
    private readonly stateStack: GameState<P, C>[] = [];
    private readonly traceSession?: TraceSession;
    protected readonly logger: Logger;
    protected readonly owner: GameEngineOwner;
    public readonly context: C;
    public readonly playerManager: GamePlayerManager<P>;
    /**当前游戏实例自己的 participation 视图，可仅凭稳定 playerId 建立参与关系。*/
    public readonly participation: GameParticipation;
    /**当前 Game 的结构化 Trace scope；未配置 Sink 时为零开销 no-op。*/
    public readonly trace: TraceScope;
    public readonly key: string;
    private _lifecycle: GameLifecycleState = "created";
    private membershipSubscription?: Subscription;
    private readonly managedSubscriptions = new Set<Subscription>();
    private readonly participantGroups = new Set<PlayerGroup<P> | PlayerGroupSet<P>>();
    private readonly pendingParticipantLeaves = new Map<string, ParticipationChange>();

    /**是否是常驻游戏（常驻游戏不会被game end结束) */
    get isDaemon() {
        return false;
    }

    get lifecycle(): Readonly<GameLifecycleState> {
        return this._lifecycle;
    }

    /**只有 starting/running 阶段允许继续创建运行时资源。*/
    get isActive() {
        return this._lifecycle === "starting" || this._lifecycle === "running";
    }

    /**玩家组构建器 */
    get groupBuilder() {
        return this.playerManager.groupBuilder;
    }

    constructor(
        playerClass: classConstructor<P>,
        owner: GameEngineOwner,
        key: string,
        config?: O
    ) {
        this.owner = owner;
        this.key = key;
        this.logger = new Logger(this.constructor.name);
        this.traceSession = owner.trace.getSession(key);
        this.trace = this.traceSession?.game ?? NOOP_TRACE_SCOPE;
        this.participation = new GameParticipation(
            owner.participation,
            key,
            !this.isDaemon
        );
        this.playerManager = new GamePlayerManager(
            playerClass,
            this.participation,
            this.traceSession
        );

        try {
            this.context = this.buildContext(config ?? ({} as O));
        } catch (buildError) {
            // buildContext 在派生类构造期间执行，GameManager 尚未拿到实例，
            // 因此这里必须自行回滚期间创建的 wrapper / participation。
            try {
                this.playerManager.dispose();
            } catch (cleanupError) {
                throw new AggregateError(
                    [buildError, cleanupError],
                    `Game ${key} buildContext 失败且 participation 回滚异常`
                );
            }
            throw buildError;
        }
    }

    protected abstract buildContext(config: O): C;

    /** Keep a game-level subscription alive across states and release it on any dispose path. */
    protected trackSubscription(subscription: Subscription): Subscription {
        this.managedSubscriptions.add(subscription);
        return subscription;
    }

    /**
     * Explicitly bind groups whose members must leave when Participation is released.
     * Do not bind waiting-room or spectator groups unless they share that ownership.
     */
    protected bindParticipantGroups(...groups: (PlayerGroup<P> | PlayerGroupSet<P>)[]): void {
        for (const group of groups) this.participantGroups.add(group);
    }

    /** Runs after managed group cleanup, in a writable tick. */
    protected onParticipantLeft(_event: ParticipationChange): void {}

    private queueParticipantLeave(event: ParticipationChange): void {
        if (event.type !== "left") return;
        // Membership and GamePlayer.isActive are invalidated synchronously by
        // ParticipationManager / GamePlayerManager. Group.changed listeners may
        // touch the native API, so group mutations must run outside before-events.
        const first = !this.pendingParticipantLeaves.has(event.playerId);
        this.pendingParticipantLeaves.set(event.playerId, event);
        if (!first) return;
        system.run(() => {
            const latest = this.pendingParticipantLeaves.get(event.playerId);
            this.pendingParticipantLeaves.delete(event.playerId);
            if (!latest || !this.isActive || this.participation.has(event.playerId)) return;
            for (const group of this.participantGroups) {
                if (group instanceof PlayerGroupSet) {
                    const member = group.findById(event.playerId)?.player;
                    if (member) group.removePlayer(member, "participation-left");
                } else {
                    const member = group.getById(event.playerId);
                    if (member) group.delete(member, "participation-left");
                }
            }
            try {
                this.onParticipantLeft(latest);
            } catch (error) {
                this.logger.error("Participant leave handler failed", error);
            }
        });
    }

    /**游戏开始 */
    protected abstract onStart(): void;

    /**游戏结束(dispose前调用) */
    protected abstract onStop(): void;

    /** @internal GameState constructor uses this to get a stable state ref. */
    createStateTraceScope(state: object, name: string) {
        return this.traceSession?.createStateScope(state, name) ?? NOOP_TRACE_SCOPE;
    }

    /** @internal GameState uses this before component attach. */
    createComponentTraceScope(
        component: object,
        state: object,
        name: string,
        tag?: string
    ) {
        return (
            this.traceSession?.createComponentScope(component, state, name, tag) ??
            NOOP_TRACE_SCOPE
        );
    }

    /** @internal State/Component helpers that need a named runner/timer scope. */
    createNamedTraceScope(
        kind: "runner" | "timer" | "system",
        name: string,
        ref?: number
    ) {
        return (
            this.traceSession?.createNamedScope(kind, name, ref) ?? NOOP_TRACE_SCOPE
        );
    }

    /**
     * 在栈顶添加新的子状态。
     * 若 onEnter 失败，会回滚该状态在进入期间创建的整个子状态树。
     */
    pushState<S extends gameStateConstructor<P, C, any>>(
        stateType: S,
        config?: ExtractConfig<S>
    ) {
        if (!this.isActive) return this;
        this.logger.debug(`Pushing state: ${stateType.name}`);

        const startIndex = this.stateStack.length;
        const stateInstance = new stateType(this, config);
        this.stateStack.push(stateInstance);
        stateInstance.trace.builtin(BuiltinTraceEventType.StatePush, {
            depth: startIndex,
            state: stateType.name,
        });

        try {
            (stateInstance as any as GameStateInternal)._onEnter();
            stateInstance.trace.builtin(BuiltinTraceEventType.StateEnter, {
                depth: startIndex,
            });
            if (startIndex === 0) {
                stateInstance.trace.builtin(BuiltinTraceEventType.StateRootChanged, {
                    to: stateType.name,
                });
            }
        } catch (enterError) {
            stateInstance.trace.builtin(BuiltinTraceEventType.StateEnterFailed, {
                error: traceErrorValue(enterError),
            });
            const rollbackStates = this.stateStack.splice(startIndex);
            const cleanupErrors: unknown[] = [];

            // 子状态已经完整进入，按正常退出语义从栈顶向下清理。
            for (let i = rollbackStates.length - 1; i >= 1; i--) {
                try {
                    this.removeState(rollbackStates[i], "parent-enter-rollback");
                } catch (err) {
                    cleanupErrors.push(err);
                }
            }

            // 当前状态自身没有完成 onEnter，不调用用户 onExit，只释放已创建资源。
            try {
                (stateInstance as any as GameStateInternal)._onEnterFailed();
            } catch (err) {
                cleanupErrors.push(err);
            }

            if (cleanupErrors.length > 0) {
                throw new AggregateError(
                    [enterError, ...cleanupErrors],
                    `State ${stateType.name} 进入失败且回滚异常`
                );
            }
            throw enterError;
        }
        return this;
    }

    /** 移除栈顶的状态，返回到父状态 */
    popState() {
        const topState = this.stateStack.pop();
        if (topState) this.removeState(topState, "pop");
    }

    /** 清空所有状态，并设置一个新的根状态 */
    resetState<S extends gameStateConstructor<P, C, any>>(
        stateType: S,
        config?: ExtractConfig<S>
    ) {
        if (!this.isActive) return this;
        this.logger.debug(`Setting root state to: ${stateType.name}`);
        const previousRoot = this.stateStack[0]?.constructor.name;
        this.trace.builtin(BuiltinTraceEventType.StateTransition, {
            operation: "resetState",
            ...(previousRoot ? { from: previousRoot } : {}),
            to: stateType.name,
        });
        this.clearStateStack("reset");
        this.pushState(stateType, config);
        return this;
    }

    /** 从指定的状态实例开始替换状态分支。*/
    replaceFrom<S extends gameStateConstructor<P, C, any>>(
        stateToReplace: GameState<P, C>,
        newStateType: S,
        config?: ExtractConfig<S>
    ) {
        if (!this.isActive) return this;
        this.logger.debug(
            `Replacing from ${stateToReplace.constructor.name} with ${newStateType.name}`
        );

        const index = this.stateStack.indexOf(stateToReplace);
        if (index === -1) {
            this.logger.error(
                `无法找到要替换的状态实例:${stateToReplace.constructor.name}`
            );
            throw new GameEngineError("State to replace not found in stack.");
        }

        stateToReplace.trace.builtin(BuiltinTraceEventType.StateTransition, {
            operation: "replaceFrom",
            from: stateToReplace.constructor.name,
            to: newStateType.name,
            depth: index,
        });
        const errors: unknown[] = [];
        while (this.stateStack.length > index) {
            const removed = this.stateStack.pop()!;
            try {
                this.removeState(removed, "replace");
            } catch (err) {
                errors.push(err);
            }
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "替换 State 分支时清理失败");
        }
        this.pushState(newStateType, config);
        return this;
    }

    private clearStateStack(reason = "clear") {
        const previousRoot = this.stateStack[0]?.constructor.name;
        const errors: unknown[] = [];
        while (this.stateStack.length > 0) {
            const state = this.stateStack.pop()!;
            try {
                this.removeState(state, reason);
            } catch (err) {
                errors.push(err);
            }
        }
        if (previousRoot) {
            this.trace.builtin(BuiltinTraceEventType.StateRootChanged, {
                from: previousRoot,
                to: "<none>",
                reason,
            });
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "State 栈清理失败");
        }
    }

    private removeState(state: GameState<P, C>, reason: string) {
        this.logger.debug(`Removing state: ${state.constructor.name}`);
        state.trace.builtin(BuiltinTraceEventType.StateExit, { reason });
        try {
            (state as any as GameStateInternal)._onExit();
            state.trace.builtin(BuiltinTraceEventType.StateRemove, {
                reason,
                success: true,
            });
        } catch (error) {
            state.trace.builtin(BuiltinTraceEventType.StateRemove, {
                reason,
                success: false,
                error: traceErrorValue(error),
            });
            throw error;
        }
    }

    getNextState(state: GameState<P, C>): GameState<P, C> | undefined {
        const index = this.stateStack.findIndex((s) => s === state);
        if (index != -1 && this.stateStack.length > index + 1) {
            return this.stateStack[index + 1];
        }
    }

    getLastState(state: GameState<P, C>): GameState<P, C> | undefined {
        const index = this.stateStack.findIndex((s) => s === state);
        if (index > 0) return this.stateStack[index - 1];
    }

    getState<T extends GameState<P, C, any>>(stateType: classConstructor<T>) {
        const state = this.stateStack.find((s) => s.constructor == stateType);
        if (state) return state as T;
    }

    deleteState(stateType: gameStateConstructor<P, C, any>) {
        const idx = this.stateStack.findIndex(
            (s) => s.constructor == stateType
        );
        if (idx != -1) {
            const [removed] = this.stateStack.splice(idx, 1);
            this.removeState(removed, "delete");
            if (idx === 0) {
                this.trace.builtin(BuiltinTraceEventType.StateRootChanged, {
                    from: removed.constructor.name,
                    to: this.stateStack[0]?.constructor.name ?? "<none>",
                    reason: "delete",
                });
            }
        }
    }

    stats(detail: boolean = false): string {
        let stateLine: string;
        const stateNames = this.stateStack.map((s) => s.constructor.name);
        const playersLine = `§ePlayers§r: §a${this.playerManager.validSize}§r / §7${this.playerManager.activeSize} active / ${this.playerManager.size} wrappers §8(participants ${this.participation.size})`;
        if (detail) {
            const stateStats = this.stateStack.map((s) => s.stats());
            stateLine =
                stateNames.length > 0
                    ? `§eStates§r(${stateNames.length}): \n    ${stateStats.join("\n    ")}`
                    : `§eStates§r: §7<empty>`;
        } else {
            stateLine =
                stateNames.length > 0
                    ? `§eStates§r(${stateNames.length}): §b${stateNames.join(
                          " §7| §b"
                      )}`
                    : `§eStates§r: §7<empty>`;
        }
        return ["", playersLine, stateLine].join("\n  ");
    }

    stopGame(reason = "game.stopGame") {
        if (this._lifecycle === "stopping" || this._lifecycle === "disposed") {
            return;
        }
        this.owner.stopGameByKey(this.key, reason);
    }

    /** @internal */
    private _onStart() {
        if (this._lifecycle !== "created") {
            throw new GameEngineError(
                `不能从 ${this._lifecycle} 状态启动游戏 ${this.key}`
            );
        }
        this._lifecycle = "starting";
        this.membershipSubscription = this.participation.changed.subscribe((event) =>
            this.queueParticipantLeave(event)
        );
        this.onStart();
        if (this._lifecycle === "starting") {
            this._lifecycle = "running";
        }
    }

    /** @internal */
    private _onStop() {
        if (this._lifecycle === "stopping" || this._lifecycle === "disposed") {
            return;
        }
        this._lifecycle = "stopping";
        this.onStop();
    }

    /** @internal */
    private _onDispose() {
        if (this._lifecycle === "disposed") return;
        if (this._lifecycle !== "stopping") this._lifecycle = "stopping";

        const errors: unknown[] = [];
        this.membershipSubscription?.unsubscribe();
        this.membershipSubscription = undefined;
        this.pendingParticipantLeaves.clear();
        for (const subscription of this.managedSubscriptions) {
            try {
                subscription.unsubscribe();
            } catch (error) {
                errors.push(error);
            }
        }
        this.managedSubscriptions.clear();
        try {
            this.clearStateStack("game-dispose");
        } catch (err) {
            errors.push(err);
        }
        try {
            this.playerManager.dispose();
        } catch (err) {
            errors.push(err);
        } finally {
            this._lifecycle = "disposed";
        }

        if (errors.length > 0) {
            throw new AggregateError(errors, `Game ${this.key} 清理失败`);
        }
    }
}

export interface GameEngineInternal {
    _onStart(): void;
    _onStop(): void;
    _onDispose(): void;
}
