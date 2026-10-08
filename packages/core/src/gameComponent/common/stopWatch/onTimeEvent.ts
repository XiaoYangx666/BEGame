import { CustomEventSignal } from "@begame/core/gameEvent/eventSignal";
import { Subscription } from "@begame/core/gameEvent/subscription";
import { Logger } from "@begame/core/utils/logger";

interface StopWatchOnTimeEventData {
    time: number;
    callback: () => void;
    once: boolean;
}

export class StopWatchOnTimeEventSignal implements CustomEventSignal<void> {
    private readonly logger = new Logger(this.constructor.name);
    private events: StopWatchOnTimeEventData[] = [];

    subscribe(
        callback: () => void,
        options: { time: number; once?: boolean }
    ): Subscription {
        const event: StopWatchOnTimeEventData = {
            time: options.time,
            callback,
            once: options.once ?? true,
        };
        this.events.push(event);
        return {
            unsubscribe: () => {
                this.events = this.events.filter((e) => e !== event);
            },
        };
    }

    /**检查并触发到达时间的事件*/
    checkAndFireTimeEvents(time: number): void {
        const eventsToFire = this.events.filter((event) => time === event.time);

        eventsToFire.forEach((event) => {
            try {
                event.callback();
            } catch (e) {
                this.logger.error("执行stopWatch事件失败:", e);
            }
        });

        // 如果配置为once，则在执行后移除
        this.events = this.events.filter(
            (event) => !event.once || !eventsToFire.includes(event)
        );
    }
}
