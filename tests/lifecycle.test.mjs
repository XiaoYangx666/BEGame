import { expect, test, vi } from "vitest";
import {
    DisconnectTimeoutComponent,
    AutoStopComponent,
    Game,
    GameComponent,
    GameContext,
    GameEngine,
    GamePlayer,
    PlayerGroup,
    PlayerGroupSet,
    GameState,
} from "../packages/core/dist/main.js";
import { Logger } from "../packages/core/dist/utils/logger.js";
import { Duration } from "../packages/core/dist/utils/index.js";
import { BEGameTestEngine } from "../packages/test/dist/index.js";

class TraceContext extends GameContext {
    constructor(config = {}) {
        super();
        this.trace = config.trace ?? [];
        this.initialPlayer = config.initialPlayer;
        this.timeoutTicks = config.timeoutTicks ?? 5;
        this.stopGameWhenEmpty = config.stopGameWhenEmpty ?? false;
        this.throwOnTimeout = config.throwOnTimeout ?? false;
        this.counter = config.counter ?? 0;
    }
}

class TracePlayer extends GamePlayer {}

class TraceComponent extends GameComponent {
    onAttach() { this.context.trace.push("component:attach"); }
    onDetach() { this.context.trace.push("component:detach"); }
}

class ChildState extends GameState {
    onEnter() { this.context.trace.push("child:enter"); }
    onExit() { this.context.trace.push("child:exit"); }
}

class RootState extends GameState {
    onEnter() {
        this.context.trace.push("root:enter");
        this.addComponent(TraceComponent);
        this.runner.runDelay(() => this.context.trace.push("runner:delay"), 5);
    }
    onExit() { this.context.trace.push("root:exit"); }
}

class TraceGame extends GameEngine {
    static gameType = "test-trace";
    constructor(owner, key, config) { super(TracePlayer, owner, key, config); }
    buildContext(config) { return new TraceContext(config); }
    onStart() {
        this.context.trace.push("game:start");
        if (this.context.initialPlayer) {
            expect(this.playerManager.join(this.context.initialPlayer).allowed).toBe(true);
        }
        this.resetState(RootState);
    }
    onStop() { this.context.trace.push("game:stop"); }
}

class ManagedMembershipGame extends TraceGame {
    static gameType = "test-managed-membership";
    onStart() {
        super.onStart();
        const player = this.playerManager.get(this.context.initialPlayer);
        const red = new PlayerGroup(TracePlayer, [player]);
        const blue = new PlayerGroup(TracePlayer, [player]);
        this.context.groups = [red, blue];
        this.bindParticipantGroups(new PlayerGroupSet([red, blue]));
    }
    onParticipantLeft(event) {
        this.context.trace.push(`left:${event.playerId}:${event.reason}`);
    }
}

class DisconnectRootState extends GameState {
    onEnter() {
        this.context.trace.push("disconnect-root:enter");
        this.addComponent(DisconnectTimeoutComponent, {
            timeout: new Duration(this.context.timeoutTicks),
            releaseOnTimeout: true,
            stopGameWhenEmpty: this.context.stopGameWhenEmpty,
            onOffline: (id) => this.context.trace.push(`offline:${id}`),
            onOnline: (id) => this.context.trace.push(`online:${id}`),
            onTimeout: (id) => {
                this.context.trace.push(`timeout:${id}`);
                if (this.context.throwOnTimeout) throw new Error("intentional-timeout-callback-failure");
            },
        });
    }
    onExit() { this.context.trace.push("disconnect-root:exit"); }
}

class DisconnectGame extends TraceGame {
    static gameType = "test-disconnect";
    onStart() {
        this.context.trace.push("game:start");
        if (this.context.initialPlayer) {
            expect(this.playerManager.join(this.context.initialPlayer).allowed).toBe(true);
        }
        this.resetState(DisconnectRootState);
    }
}

class AutoStopRootState extends GameState {
    onEnter() {
        this.addComponent(AutoStopComponent, {
            canStop: () => this.context.allowStop !== false,
        });
    }
}

class AutoStopGame extends TraceGame {
    static gameType = "test-autostop";
    onStart() {
        this.context.trace.push("game:start");
        if (this.context.initialPlayer) {
            expect(this.playerManager.join(this.context.initialPlayer).allowed).toBe(true);
        }
        this.resetState(AutoStopRootState);
    }
}

class ReloadGame extends GameEngine {
    static gameType = "test-reload";
    constructor(owner, key, config) { super(TracePlayer, owner, key, config); }
    buildContext(config = {}) {
        const context = new TraceContext(config);
        context.players = config.players ?? [];
        return context;
    }
    onStart() {
        this.context.trace.push("reload-game:start");
        for (const player of this.context.players) {
            expect(this.playerManager.join(player).allowed).toBe(true);
        }
        this.resetState(DisconnectRootState);
    }
    onStop() { this.context.trace.push("reload-game:stop"); }
    snapshot() {
        return { counter: this.context.counter, participants: this.participation.getAll() };
    }
}

class FailingState extends GameState {
    onEnter() {
        this.context.trace.push("failing:enter");
        this.addComponent(TraceComponent);
        throw new Error("intentional state failure");
    }
}

class FailingGame extends TraceGame {
    static gameType = "test-failing";
    onStart() {
        this.context.trace.push("game:start");
        if (this.context.initialPlayer) {
            expect(this.playerManager.join(this.context.initialPlayer).allowed).toBe(true);
        }
        this.resetState(FailingState);
    }
}

class DaemonGame extends TraceGame {
    static gameType = "test-daemon";
    get isDaemon() { return true; }
}

test("headless engine preserves Game/State/Component/Runner lifecycle ordering", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const game = env.startGame(TraceGame, { trace });
    expect(game.lifecycle).toBe("running");
    expect(trace).toEqual(["game:start", "root:enter", "component:attach"]);
    await env.advanceTicks(4);
    expect(trace).not.toContain("runner:delay");
    await env.advanceTicks(1);
    expect(trace.at(-1)).toBe("runner:delay");
    game.pushState(ChildState);
    expect(trace.at(-1)).toBe("child:enter");
    env.stopGame(TraceGame);
    expect(game.lifecycle).toBe("disposed");
    expect(trace.slice(-5)).toEqual(["child:enter", "game:stop", "child:exit", "root:exit", "component:detach"]);
    await env.advanceTicks(100);
    expect(trace.filter((item) => item === "runner:delay")).toHaveLength(1);
    env.reset();
});

test("disconnect grace period can reconnect before timeout or leave after timeout", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(DisconnectGame, {
        trace,
        initialPlayer: alice,
        timeoutTicks: 5,
        stopGameWhenEmpty: true,
    });
    expect(game.participation.has("alice")).toBe(true);
    env.disconnectPlayer("alice");
    expect(trace.at(-1)).toBe("offline:alice");
    await env.advanceTicks(4);
    expect(game.participation.has("alice")).toBe(true);
    expect(env.connectPlayer("alice", "Alice")).toBe(alice);
    expect(trace.at(-1)).toBe("online:alice");
    await env.advanceTicks(2);
    expect(trace).not.toContain("timeout:alice");
    env.disconnectPlayer("alice");
    await env.advanceTicks(5);
    expect(trace).toContain("timeout:alice");
    expect(game.participation.has("alice")).toBe(false);
    expect(env.getGame(DisconnectGame)).toBeUndefined();
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("last online player explicitly leaving stops an empty game without a disconnect event", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(DisconnectGame, {
        trace, initialPlayer: alice, timeoutTicks: 5, stopGameWhenEmpty: true,
    });

    expect(game.playerManager.leave("alice", "hub")).toBe(true);
    expect(game.participation.size).toBe(0);
    // Empty-room checks run after the caller finishes its leave transition.
    expect(game.lifecycle).toBe("running");
    await env.advanceTicks(1);
    expect(env.getGame(DisconnectGame)).toBeUndefined();
    expect(game.lifecycle).toBe("disposed");
    expect(trace.filter(item => item === "game:stop")).toHaveLength(1);
    env.reset();
});

test("same-tick replacement participant prevents an obsolete empty-room stop", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const alice = env.connectPlayer("alice", "Alice");
    const bob = env.connectPlayer("bob", "Bob");
    const game = env.startGame(DisconnectGame, {
        trace, initialPlayer: alice, timeoutTicks: 5, stopGameWhenEmpty: true,
    });

    game.playerManager.leave("alice", "hub");
    expect(game.playerManager.join(bob).allowed).toBe(true);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("running");
    expect(game.participation.getAll()).toEqual(["bob"]);
    expect(trace).not.toContain("game:stop");
    env.reset();
});

test("AutoStop reclaims a never-occupied room on its first 10-second fallback check", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const game = env.startGame(AutoStopGame, { trace: [] });
    await env.advanceTicks(199);
    expect(game.lifecycle).toBe("running");
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("AutoStop still reclaims a vacated room within one tick of a membership event", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const game = env.startGame(AutoStopGame, { trace: [] });
    const alice = env.connectPlayer("alice", "Alice");
    expect(game.playerManager.join(alice).allowed).toBe(true);
    expect(game.playerManager.leave("alice", "hub")).toBe(true);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("AutoStop periodic fallback observes canStop changes without manual reconcile", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(AutoStopGame, { trace: [], initialPlayer: alice });
    game.context.allowStop = false;
    game.playerManager.leave("alice", "hub");
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("running");
    game.context.allowStop = true;
    await env.advanceTicks(198);
    expect(game.lifecycle).toBe("running");
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("AutoStop periodic fallback detects silent changes in a custom membership source", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const game = env.startGame(AutoStopGame, { trace: [] });
    const state = game.getState(AutoStopRootState);
    state.deleteComponent(AutoStopComponent);
    const members = ["alice"];
    state.addComponent(AutoStopComponent, {
        getMemberIds: () => members,
        memberChanged: { subscribe: () => ({ unsubscribe() {} }) },
    });
    members.length = 0; // Deliberately simulate a missed notification.
    await env.advanceTicks(199);
    expect(game.lifecycle).toBe("running");
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("AutoStop detaches its periodic fallback with the component", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const game = env.startGame(AutoStopGame, { trace: [] });
    game.getState(AutoStopRootState).deleteComponent(AutoStopComponent);
    await env.advanceTicks(220);
    expect(game.lifecycle).toBe("running");
    env.reset();
});

test("AutoStop canStop veto remains recheckable after the room becomes empty", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(AutoStopGame, { trace: [], initialPlayer: alice });
    game.context.allowStop = false;
    game.playerManager.leave("alice", "hub");
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("running");

    game.context.allowStop = true;
    game.getState(AutoStopRootState).getComponent(AutoStopComponent).reconcile();
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("AutoStop does not bypass a disconnected participant's unreleased grace period", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(AutoStopGame, { trace: [], initialPlayer: alice });
    game.getState(AutoStopRootState).addComponent(DisconnectTimeoutComponent, {
        timeout: Duration.fromTicks(5),
        releaseOnTimeout: true,
    });
    env.disconnectPlayer("alice");
    await env.advanceTicks(4);
    expect(game.lifecycle).toBe("running");
    expect(game.participation.has("alice")).toBe(true);
    await env.advanceTicks(1);
    expect(game.participation.has("alice")).toBe(false);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("AutoStop rejects incomplete or competing membership sources", () => {
    const env = new BEGameTestEngine();
    env.reset();
    const game = env.startGame(AutoStopGame, { trace: [] });
    const state = game.getState(AutoStopRootState);
    state.deleteComponent(AutoStopComponent);
    const groupSet = new PlayerGroupSet([new PlayerGroup(GamePlayer)]);

    // GameState wraps component errors in ComponentLoadFailedError; assert the
    // original configuration error survives as its cause and attach rolls back.
    const expectRejected = (options, expected) => {
        let error;
        try {
            state.addComponent(AutoStopComponent, options);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect(error.cause?.message).toMatch(expected);
        expect(() => state.getComponent(AutoStopComponent)).toThrow();
    };
    expectRejected({ memberChanged: groupSet.changed }, /getMemberIds and memberChanged/);
    expectRejected({ getMemberIds: () => [] }, /getMemberIds and memberChanged/);
    expectRejected({
        groupSet, getMemberIds: () => [], memberChanged: groupSet.changed,
    }, /either groupSet or a custom member source/);

    env.reset();
});

test("game-owned participant groups are cleaned after leave, without restricted-context mutation", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    try {
        const alice = env.connectPlayer("alice", "Alice");
        const trace = [];
        const game = env.startGame(ManagedMembershipGame, { trace, initialPlayer: alice });
        const [red, blue] = game.context.groups;

        // Logical participation becomes invalid immediately; observable group
        // changes are deferred because subscribers may touch Minecraft APIs.
        game.playerManager.leave("alice", "hub");
        expect(game.participation.has("alice")).toBe(false);
        expect(red.size).toBe(1);
        expect(blue.size).toBe(1);
        await env.advanceTicks(1);
        expect(red.size).toBe(0);
        expect(blue.size).toBe(0);
        expect(trace).toContain("left:alice:hub");

        game.playerManager.join(alice);
        red.add(game.playerManager.get(alice));
        game.playerManager.leave("alice", "hub");
        game.playerManager.join(alice);
        await env.advanceTicks(1);
        expect(red.size).toBe(1);
        expect(trace.filter(x => x === "left:alice:hub")).toHaveLength(1);

        game.playerManager.leave("alice", "leave-all");
        env.manager.disposeAll();
        await env.advanceTicks(1);
        expect(trace.filter(x => x === "left:alice:leave-all")).toHaveLength(0);
    } finally {
        env.reset();
    }
});

test("participation-scoped AutoStop preserves offline grace even if an operational group purges invalid wrappers", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(AutoStopGame, { trace: [], initialPlayer: alice });
    const group = new PlayerGroup(GamePlayer, [game.playerManager.get(alice)]);
    game.getState(AutoStopRootState).addComponent(DisconnectTimeoutComponent, {
        timeout: Duration.fromTicks(5),
        releaseOnTimeout: true,
    });

    env.disconnectPlayer("alice");
    group.clearInvalid();
    expect(group.size).toBe(0);
    await env.advanceTicks(4);
    expect(game.lifecycle).toBe("running");
    expect(game.participation.has("alice")).toBe(true);
    await env.advanceTicks(1);
    expect(game.participation.has("alice")).toBe(false);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("group-scoped AutoStop observes group removal and participation release independently", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(AutoStopGame, { trace: [], initialPlayer: alice });
    const state = game.getState(AutoStopRootState);
    state.deleteComponent(AutoStopComponent);
    const group = new PlayerGroup(GamePlayer, [game.playerManager.get(alice)]);
    const groupSet = new PlayerGroupSet([group]);
    state.addComponent(AutoStopComponent, { groupSet });

    // Membership remains in the group, but the scope must intersect the
    // authoritative game participation after an explicit leave.
    game.playerManager.leave("alice", "hub");
    expect(group.size).toBe(1);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("group-scoped AutoStop treats a real group deletion as room exit", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(AutoStopGame, { trace: [], initialPlayer: alice });
    const state = game.getState(AutoStopRootState);
    state.deleteComponent(AutoStopComponent);
    const group = new PlayerGroup(GamePlayer, [game.playerManager.get(alice)]);
    const groupSet = new PlayerGroupSet([group]);
    state.addComponent(AutoStopComponent, { groupSet });

    group.delete(alice, "region-leave");
    expect(game.participation.has("alice")).toBe(true);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("Game.server online lookups reflect the current world without cached connection state", () => {
    const env = new BEGameTestEngine();
    env.reset();
    expect(Game.server.getPlayer("alice")).toBeUndefined();
    expect(Game.server.isOnline("alice")).toBe(false);
    const alice = env.connectPlayer("alice", "Alice");
    expect(Game.server.getPlayer("alice")).toBe(alice);
    expect(Game.server.isOnline("alice")).toBe(true);
    env.disconnectPlayer("alice");
    expect(Game.server.getPlayer("alice")).toBeUndefined();
    expect(Game.server.isOnline("alice")).toBe(false);
    env.reset();
});

test("runtime participation.clear broadcasts removals and allows AutoStop to end the game", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(AutoStopGame, { trace: [], initialPlayer: alice });
    expect(game.participation.clear()).toEqual(["alice"]);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("disconnect guard observes participants restored offline after component attach", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const game = env.startGame(DisconnectGame, {
        trace, timeoutTicks: 2, stopGameWhenEmpty: true,
    });
    expect(game.participation.join("alice").allowed).toBe(true);
    await env.advanceTicks(1);
    expect(game.participation.has("alice")).toBe(true);
    await env.advanceTicks(2);
    expect(trace).toContain("timeout:alice");
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("group-scoped disconnect timeout observes an offline member added after attach", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const game = env.startGame(AutoStopGame, { trace: [] });
    const state = game.getState(AutoStopRootState);
    const group = new PlayerGroup(GamePlayer);
    const groupSet = new PlayerGroupSet([group]);
    state.addComponent(DisconnectTimeoutComponent, {
        groupSet, timeout: Duration.fromTicks(2), releaseOnTimeout: true,
    });

    expect(game.participation.join("alice").allowed).toBe(true);
    await env.advanceTicks(1);
    expect(game.participation.has("alice")).toBe(true);
    group.add(new GamePlayer({ id: "alice", name: "Alice", isValid: false }));
    await env.advanceTicks(2);
    expect(game.participation.has("alice")).toBe(false);
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("timeout callback exceptions cannot suppress automatic participant release", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const alice = env.connectPlayer("alice", "Alice");
    const game = env.startGame(DisconnectGame, {
        trace: [], initialPlayer: alice, timeoutTicks: 2,
        stopGameWhenEmpty: true, throwOnTimeout: true,
    });
    const errors = [];
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation((...args) => errors.push(args));
    try {
        env.disconnectPlayer("alice");
        await env.advanceTicks(3);
        expect(game.participation.has("alice")).toBe(false);
        expect(game.lifecycle).toBe("disposed");
        expect(errors.some(args => args.some(value => String(value).includes("intentional-timeout-callback-failure")))).toBe(true);
    } finally {
        spy.mockRestore();
        env.reset();
    }
});

class OfflineAtStartDisconnectGame extends DisconnectGame {
    static gameType = "test-offline-at-start";
    onStart() {
        expect(this.participation.join("alice").allowed).toBe(true);
        this.resetState(DisconnectRootState);
    }
}

test("zero-tick timeout of an offline initial member does not stop inside component attach", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const game = env.startGame(OfflineAtStartDisconnectGame, {
        trace: [], timeoutTicks: 0, stopGameWhenEmpty: true,
    });
    expect(game.lifecycle).toBe("running");
    await env.advanceTicks(1);
    expect(game.lifecycle).toBe("disposed");
    env.reset();
});

test("reload keeps virtual world players but rebuilds game runtime from snapshot", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const alice = env.connectPlayer("alice", "Alice");
    const bob = env.connectPlayer("bob", "Bob");
    const before = env.startGame(ReloadGame, { trace, players: [alice, bob], counter: 42, timeoutTicks: 5 });
    const after = await env.reload({
        snapshot: () => before.snapshot(),
        restore: (snapshot) => env.startGame(ReloadGame, {
            trace,
            players: snapshot.participants.map((id) => env.getPlayer(id)),
            counter: snapshot.counter,
            timeoutTicks: 5,
        }),
    });
    expect(after).not.toBe(before);
    expect(before.lifecycle).toBe("disposed");
    expect(after.lifecycle).toBe("running");
    expect(after.context.counter).toBe(42);
    expect(after.participation.getAll().sort()).toEqual(["alice", "bob"]);
    expect(env.getPlayer("alice")).toBe(alice);
    expect(env.getPlayer("bob")).toBe(bob);
    expect(trace).not.toContain("reload-game:stop");
    env.reset();
});

test("failed game startup rolls back state resources and participation atomically", () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const alice = env.connectPlayer("alice", "Alice");
    expect(() => env.startGame(FailingGame, { trace, initialPlayer: alice })).toThrow(/intentional state failure/);
    expect(env.getGame(FailingGame)).toBeUndefined();
    expect(env.manager.participation.has("alice")).toBe(false);
    expect(trace).toEqual(["game:start", "failing:enter", "component:attach", "component:detach"]);
    env.reset();
});

test("test reset disposes daemon games as a real script reload would", () => {
    const env = new BEGameTestEngine();
    env.reset();
    const daemon = env.startGame(DaemonGame, { trace: [] });
    expect(daemon.lifecycle).toBe("running");
    env.reset();
    expect(daemon.lifecycle).toBe("disposed");
    expect(env.getGame(DaemonGame)).toBeUndefined();
});

/**
 * 回归：一个 interval 回调在同步执行中触发了 State 清理（真实场景是
 * TableEntityLifetimeComponent 检测到区块卸载后 stopGame），清理会把其它
 * 组件的订阅一起注销。tick 事先快照了回调列表，若不在调用前复查就会继续调用
 * 那个已经失效的回调，让它去访问已被删除的组件并抛错。
 */
class ReentrantStopComponent extends GameComponent {
    onAttach() {
        // 触发者必须先注册：这样它在同一 tick 的快照里排在观察者前面，
        // 才能重现「先同步 stopGame 清理，再调用已失效的观察者」这个真实顺序
        // （实际项目里 TableEntityLifetimeComponent 早于 display 组件注册）。
        this.subscribe(
            Game.events.interval,
            () => {
                this.context.trace.push("stopper:tick");
                if (!this.context.stopped) {
                    this.context.stopped = true;
                    this.state.stopGame("reentrant-stop");
                }
            },
            Duration.fromTicks(1)
        );
        // 后注册的观察者：清理发生后它已被注销，本轮不应再被调用。
        this.subscribe(
            Game.events.interval,
            () => {
                let probeAlive = true;
                try {
                    this.state.getComponent(ProbeComponent);
                } catch {
                    probeAlive = false;
                }
                if (!probeAlive) {
                    throw new Error("observer ran after its sibling was deleted");
                }
                this.context.trace.push("observer:tick");
            },
            Duration.fromTicks(1)
        );
    }
}

class ProbeComponent extends GameComponent {
    onAttach() { this.context.trace.push("probe:attach"); }
    onDetach() { this.context.trace.push("probe:detach"); }
}

class ReentrantState extends GameState {
    onEnter() {
        // 观察者先注册，触发者后注册，保证顺序稳定。
        this.addComponent(ReentrantStopComponent);
        this.addComponent(ProbeComponent);
    }
}

class ReentrantGame extends GameEngine {
    static gameType = "test-reentrant-stop";
    constructor(owner, key, config) { super(TracePlayer, owner, key, config); }
    buildContext(config) { return new TraceContext({ ...config, stopped: false }); }
    onStart() { this.resetState(ReentrantState); }
    onStop() { this.context.trace.push("game:stop"); }
}

test("interval callbacks unsubscribed by a reentrant stop are not invoked", async () => {
    const env = new BEGameTestEngine();
    env.reset();
    const trace = [];
    const game = env.startGame(ReentrantGame, { trace });

    // tick 会吞掉回调异常并只写日志，所以失败不会自然冒泡；必须显式盯住
    // Logger.error，否则这个回归测试即使在有 bug 的版本上也会通过。
    const errors = [];
    const loggerError = vi
        .spyOn(Logger.prototype, "error")
        .mockImplementation((...args) => { errors.push(args); });

    try {
        // 一整个 tick 内：stopper 触发清理并注销 observer。同一 tick 的快照里
        // 还有 observer，它必须被跳过，而不是去访问已删除的组件。
        await env.advanceTicks(1);
    } finally {
        loggerError.mockRestore();
    }

    expect(game.lifecycle).toBe("disposed");
    expect(trace).toContain("probe:detach");
    expect(errors).toEqual([]);

    // 之后再推进若干 tick，不应有任何残留回调继续跑。
    const before = trace.length;
    await env.advanceTicks(50);
    expect(trace.length).toBe(before);
    env.reset();
});
