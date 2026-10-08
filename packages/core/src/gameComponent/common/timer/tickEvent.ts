import {
    CustomEventSignal,
    EventCallBack,
} from "@begame/core/gameEvent/eventSignal";
import { Subscription } from "@begame/core/gameEvent/subscription";
import { Logger } from "@begame/core/utils";

export interface TimerTickEvent {
    remainingTime: number;
}

export class TimerTickEventSignal implements CustomEventSignal<TimerTickEvent> {
    private tickCallbacks: Set<EventCallBack<TimerTickEvent>> = new Set();
    private logger = new Logger(this.constructor.name);

    constructor() {}

    /** 注册一个在每次时间减少（每秒）时执行的回调函数*/
    subscribe(callback: (arg0: TimerTickEvent) => void): Subscription {
        this.tickCallbacks.add(callback);
        return {
            unsubscribe: () => {
                this.tickCallbacks.delete(callback);
            },
        };
    }

    publish(remainingTime: number) {
        this.tickCallbacks.forEach((cb) => {
            try {
                cb({ remainingTime: remainingTime });
            } catch (err) {
                this.logger.error("timer Tick事件执行错误", err);
            }
        });
    }
}
