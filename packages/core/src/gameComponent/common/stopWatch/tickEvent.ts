import {
    CustomEventSignal,
    EventCallBack,
} from "@begame/core/gameEvent/eventSignal";
import { Subscription } from "@begame/core/gameEvent/subscription";
import { Logger } from "@begame/core/utils";

export interface StopWatchTickEvent {
    elapsedTime: number;
}

export class StopWatchTickEventSignal
    implements CustomEventSignal<StopWatchTickEvent>
{
    private tickCallbacks: Set<EventCallBack<StopWatchTickEvent>> = new Set();
    private logger = new Logger(this.constructor.name);

    constructor() {}

    /** 注册一个在每次时间增加（每秒）时执行的回调函数*/
    subscribe(callback: (arg0: StopWatchTickEvent) => void): Subscription {
        this.tickCallbacks.add(callback);
        return {
            unsubscribe: () => {
                this.tickCallbacks.delete(callback);
            },
        };
    }

    publish(elapsedTime: number) {
        this.tickCallbacks.forEach((cb) => {
            try {
                cb({ elapsedTime: elapsedTime });
            } catch (err) {
                this.logger.error("stopWatch Tick事件执行错误", err);
            }
        });
    }
}
