/**
 * Generic, game-agnostic analysis over a decoded trace session.
 *
 * Nothing here knows about any particular game. It only understands BEGame's
 * own built-in event families plus the generic convention that a custom event
 * may carry its concrete type in `payload.type` (an "envelope" event such as
 * `<namespace>.event`). Everything else is reported as-is so the same model
 * works for every package built on BEGame.
 *
 * The result is deliberately JSON-serializable: the workbench renders it and
 * `/api/analyze` serves it to agents unchanged.
 */

const SUMMARY_LIMIT = 200;

/**
 * Built-in BEGame vocabulary. Translating the framework's own events is not
 * game-specific adaptation, so these labels stay.
 */
const BUILTIN_TITLES = {
    "game.created": "对局创建",
    "game.starting": "对局启动中",
    "game.started": "对局已启动",
    "game.start_failed": "对局启动失败",
    "game.stopping": "对局正在停止",
    "game.stopped": "对局已停止",
    "game.disposed": "对局已销毁",
    "state.push": "状态入栈",
    "state.enter": "状态进入",
    "state.exit": "状态退出",
    "state.remove": "状态移除",
    "state.transition": "状态切换",
    "state.root_changed": "根状态变更",
    "state.enter_failed": "状态进入失败",
    "component.attach_started": "组件开始挂载",
    "component.attached": "组件挂载完成",
    "component.detached": "组件卸载",
    "component.attach_failed": "组件挂载失败",
    "component.error": "组件运行错误",
    "participation.acquire": "玩家申请加入",
    "participation.joined": "玩家加入对局",
    "participation.released": "玩家离开对局",
    "participation.acquire_rejected": "加入请求被拒绝",
    "player.connect": "玩家连接",
    "player.disconnect": "玩家断开",
    "player.reconnect": "玩家重连",
    "disconnect_timeout.started": "断线超时开始",
    "disconnect_timeout.cancelled": "断线超时取消",
    "disconnect_timeout.expired": "断线超时到期",
    "runner.uncaught_error": "异步任务未捕获错误",
    "runner.cancelled": "异步任务取消",
    "event.callback_error": "事件回调错误",
    "timer.started": "计时器启动",
    "timer.expired": "计时器到期",
    "timer.cancelled": "计时器取消",
    "debug.message": "调试消息",
    "tabletop.member.changed": "Tabletop 成员变更",
    "tabletop.seat.changed": "Tabletop 席位变更",
    "tabletop.presence.changed": "Tabletop 在线状态",
    "tabletop.stage.changed": "Tabletop 对局阶段",
};

const ERROR_TYPES = new Set([
    "component.error",
    "runner.uncaught_error",
    "game.start_failed",
    "state.enter_failed",
    "event.callback_error",
]);

/** Internal machinery, hidden by default in the event stream. */
const INTERNAL_TYPES = new Set([
    "state.push",
    "state.enter",
    "state.exit",
    "state.remove",
    "component.attach_started",
    "component.attached",
    "component.detached",
    "runner.cancelled",
    "timer.started",
    "timer.cancelled",
]);

const MUTED_TYPES = new Set([
    "state.push",
    "state.enter",
    "state.exit",
    "state.remove",
    "component.attach_started",
    "component.detached",
    "runner.cancelled",
    "timer.started",
    "timer.cancelled",
]);

export const EVENT_FAMILIES = [
    "game",
    "state",
    "component",
    "participation",
    "connection",
    "timeout",
    "runtime",
    "debug",
    "domain",
];

function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}

/**
 * True for any event BEGame classifies as a failure/rejection/error.
 * @param {string} type
 * @returns {boolean}
 */
export function isErrorType(type) {
    return (
        ERROR_TYPES.has(type) ||
        type.endsWith("_failed") ||
        type.endsWith("_rejected") ||
        type.endsWith(".failed") ||
        type.endsWith(".rejected") ||
        type.endsWith(".error")
    );
}

/**
 * Trace family from built-in event namespaces and the BEGame Trace source kind.
 * Tabletop's named events are first-party integrations and remain recognized
 * when reading recordings emitted before participation/connection source scopes.
 * Unknown custom events retain the generic domain fallback.
 * @param {string} type
 * @param {string} [sourceKind]
 * @returns {import("./types").EventFamily}
 */
export function eventFamily(type, sourceKind) {
    if (type === "debug.message" || type.startsWith("debug.")) return "debug";
    if (type.startsWith("game.")) return "game";
    if (type.startsWith("state.")) return "state";
    if (type.startsWith("component.")) return "component";
    if (type.startsWith("participation.") || type === "tabletop.member.changed" || type === "tabletop.seat.changed"
        || sourceKind === "participation") return "participation";
    if (type.startsWith("player.") || type === "tabletop.presence.changed"
        || sourceKind === "connection") return "connection";
    if (type.startsWith("disconnect_timeout.")) return "timeout";
    if (
        type.startsWith("runner.") ||
        type.startsWith("timer.") ||
        type.startsWith("event.")
    ) {
        return "runtime";
    }
    return "domain";
}

/** @param {string} type @returns {import("./types").EventSeverity} */
export function eventSeverity(type) {
    if (isErrorType(type)) return "error";
    if (type === "state.transition" || type === "state.root_changed")
        return "accent";
    if (MUTED_TYPES.has(type)) return "muted";
    return "normal";
}

/**
 * True for framework plumbing that the stream hides unless asked.
 * @param {string} type
 * @returns {boolean}
 */
export function isInternalEvent(type) {
    return INTERNAL_TYPES.has(type);
}

/**
 * The concrete type of an envelope event (`<ns>.event` carrying
 * `payload.type`), or undefined for a plain event.
 * @param {{ payload?: unknown }} event
 * @returns {string | undefined}
 */
export function eventSubtype(event) {
    const payload = asRecord(event.payload);
    return typeof payload.type === "string" && payload.type.length > 0
        ? payload.type
        : undefined;
}

/**
 * Display title for any event: the concrete subtype for an envelope event,
 * the framework's own label for a built-in event, otherwise the raw type.
 * @param {{ type: string, payload?: unknown }} event
 * @returns {string}
 */
export function eventTitle(event) {
    return eventSubtype(event) ?? BUILTIN_TITLES[event.type] ?? event.type;
}

function compactValue(value) {
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (Array.isArray(value)) return value.map(compactValue).join(",");
    return JSON.stringify(value);
}

/**
 * Generic one-line summary: every scalar payload field as `key=value`.
 * Envelope subtype and structural noise are excluded.
 * @param {import("./types").TraceEvent} event
 * @returns {string}
 */
export function summarizeEvent(event) {
    const payload = asRecord(event.payload);
    const parts = [];
    for (const [key, value] of Object.entries(payload)) {
        if (key === "type") continue;
        if (
            value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            Array.isArray(value)
        ) {
            parts.push(`${key}=${compactValue(value)}`);
        }
    }
    const text = parts.join(" ");
    return text.length > SUMMARY_LIMIT
        ? `${text.slice(0, SUMMARY_LIMIT)}…`
        : text;
}

/**
 * @param {import("./types").SelectedSession} selected
 * @returns {import("./types").SessionAnalysis}
 */
export function analyzeSession(selected) {
    const { header, end, events, stats, context } = selected;

    const families = Object.fromEntries(EVENT_FAMILIES.map((name) => [name, 0]));
    const severities = { normal: 0, muted: 0, accent: 0, error: 0 };
    const internalByType = Object.create(null);
    const domainTypes = new Map();
    const components = new Map();
    const diagnostics = [];
    const domainEvents = [];

    let internalCount = 0;

    for (let index = 0; index < events.length; index++) {
        const event = events[index];
        const family = eventFamily(event.type, event.source.kind);
        const severity = eventSeverity(event.type);
        const subtype = eventSubtype(event);
        const scope = context.eventOwners[index] ?? "session";

        families[family] = (families[family] ?? 0) + 1;
        severities[severity] = (severities[severity] ?? 0) + 1;

        if (isInternalEvent(event.type)) {
            internalCount++;
            internalByType[event.type] = (internalByType[event.type] ?? 0) + 1;
        }

        if (family === "component" && event.source.ref !== undefined) {
            const key = `component:${event.source.ref}`;
            let component = components.get(key);
            if (!component) {
                component = {
                    ref: event.source.ref,
                    name: event.source.name ?? `component#${event.source.ref}`,
                    firstSequence: event.sequence,
                    lastSequence: event.sequence,
                    attachedTick: null,
                    detachedTick: null,
                    events: 0,
                    errorCount: 0,
                };
                components.set(key, component);
            }
            component.lastSequence = event.sequence;
            component.events++;
            if (event.type === "component.attached") {
                component.attachedTick ??= event.tick;
                if (event.source.name) component.name = event.source.name;
            }
            if (event.type === "component.detached") {
                component.detachedTick ??= event.tick;
            }
            if (severity === "error") component.errorCount++;
        }

        if (severity === "error") {
            diagnostics.push({
                index,
                sequence: event.sequence,
                tick: event.tick,
                type: event.type,
                subtype,
                family,
                scope,
                message:
                    typeof asRecord(event.payload).message === "string"
                        ? asRecord(event.payload).message
                        : undefined,
                payload: event.payload,
            });
        }

        if (family === "domain") {
            const key = subtype ?? event.type;
            let entry = domainTypes.get(key);
            if (!entry) {
                entry = {
                    type: event.type,
                    subtype,
                    count: 0,
                    firstSequence: event.sequence,
                    lastSequence: event.sequence,
                };
                domainTypes.set(key, entry);
            }
            entry.count++;
            entry.lastSequence = event.sequence;
            domainEvents.push({
                index,
                sequence: event.sequence,
                tick: event.tick,
                type: event.type,
                subtype,
                scope,
                severity,
                summary: summarizeEvent(event),
                payload: event.payload,
            });
        }
    }

    return {
        sessionId: header.sessionId,
        gameType: header.gameType,
        gameKey: header.gameKey,
        gameInstanceId: header.gameInstanceId,
        status: end.status,
        endReason: end.endReason,
        startTick: header.startTick,
        endTick: end.endTick,
        startWallTime: header.startWallTime,
        endWallTime: end.endWallTime,
        durationMs: end.endWallTime - header.startWallTime,
        tickSpan: stats.tickSpan,
        eventCount: end.eventCount,
        chunkCount: end.chunkCount,
        families,
        severities,
        typeCounts: stats.typeCounts,
        sourceCounts: stats.sourceCounts,
        internalCount,
        internalByType,
        playerCount: context.players.length,
        seatCount: context.seats.length,
        errorCount: diagnostics.length,
        domainCount: domainEvents.length,
        players: context.players,
        seats: context.seats,
        stateTree: context.nodes,
        components: [...components.values()].sort(
            (a, b) => a.firstSequence - b.firstSequence
        ),
        domainTypes: [...domainTypes.values()].sort(
            (a, b) => a.firstSequence - b.firstSequence
        ),
        domainEvents,
        diagnostics,
    };
}
