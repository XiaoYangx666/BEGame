import { system } from "@minecraft/server";
import { Logger } from "@begame/core/utils";
import { Duration } from "../../utils/duration";
import { CustomEventSignal } from "../eventSignal";
import { Subscription } from "../subscription";

interface IntervalEventData {
    callback: () => void;
    interval: number;
    tickCount: number;
    /**置为 false 后，本轮 tick 不再调用该回调。 */
    active: boolean;
}

/**
 * 按需运行的间隔时间事件。没有订阅者时不会保留 Minecraft interval。
 *
 * tick 会先快照回调列表再逐个调用，而这些回调可能**同步地重入并注销自己**
 * （典型场景：State 清理时 `stopGame` 在某个回调内同步执行，删光组件并退订）。
 * 快照无法感知循环中途发生的退订，于是已经失效的回调仍会被调用一次，去访问
 * 已经删掉的组件并抛错。因此每个回调执行前都要复查 active，并在每轮结束时
 * 丢掉已失效的条目。
 */
export class IntervalEventSignal implements CustomEventSignal<void> {
    private intervalId: number | null = null;
    private readonly items = new Set<IntervalEventData>();
    private readonly logger = new Logger(this.constructor.name);

    subscribe(callback: () => void, interval?: Duration): Subscription {
        const ticks = Math.max(1, interval?.ticks ?? 1);
        const data: IntervalEventData = {
            callback,
            interval: ticks,
            tickCount: ticks,
            active: true,
        };
        this.items.add(data);
        if (this.intervalId === null) this.start();

        let unsubscribed = false;
        return {
            unsubscribe: () => {
                if (unsubscribed) return;
                unsubscribed = true;
                data.active = false;
                this.items.delete(data);
                if (this.items.size === 0) this.stop();
            },
        };
    }

    private start() {
        if (this.intervalId !== null) return;
        this.intervalId = system.runInterval(() => this.tick());
    }

    private stop() {
        if (this.intervalId === null) return;
        system.clearRun(this.intervalId);
        this.intervalId = null;
    }

    private tick() {
        for (const item of [...this.items]) {
            // 前一个回调可能已同步触发清理并注销了这个回调；跳过它，
            // 不要再去访问已经被删除的组件。
            if (!item.active) continue;
            item.tickCount--;
            if (item.tickCount <= 0) {
                try {
                    item.callback();
                } catch (e) {
                    this.logger.error("Interval callback error:", e);
                }
                item.tickCount = item.interval;
            }
        }
    }

    dispose() {
        for (const item of this.items) item.active = false;
        this.items.clear();
        this.stop();
    }
}
