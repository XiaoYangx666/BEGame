import { Logger } from "@begame/core/utils";
import { CustomEventSignal } from "./eventSignal";
import { Subscription } from "./subscription";

/** 通用的订阅数据 */
export interface SubscriptionData<TEvent> {
    callback: (event: TEvent) => void;
}

/** 通用事件信号基类 */
export abstract class BaseMapEventSignal<
    TKey,
    TEvent,
    TData extends SubscriptionData<TCustomEvent>,
    TOptions,
    TCustomEvent = TEvent
> implements CustomEventSignal<TCustomEvent>
{
    protected logger = new Logger(this.constructor.name);
    protected map: Map<TKey, Set<TData>> = new Map();

    protected totalCount = 0;
    private inited = false;
    private nativeUnsub?: (e: TEvent) => void;

    subscribe(
        callback: (event: TCustomEvent) => void,
        options: TOptions
    ): Subscription {
        const key = this.buildKey(options);
        if (key == null) {
            throw new Error("必须提供有效的订阅 key");
        }

        if (!this.inited) {
            this.init();
        }

        let set = this.map.get(key);
        if (!set) {
            set = new Set();
            this.map.set(key, set);
        }

        const data = this.buildData(callback, options);
        set.add(data);
        this.totalCount++;

        return this.wrapUnsub(key, data);
    }

    private wrapUnsub(key: TKey, data: TData) {
        let unsubscribed = false;

        return {
            unsubscribe: () => {
                if (unsubscribed) return;
                unsubscribed = true;

                const set = this.map.get(key);
                if (!set) return;

                if (set.delete(data)) {
                    this.totalCount--;
                    if (set.size === 0) this.map.delete(key);
                }

                if (this.totalCount === 0) this.cleanup();
            },
        };
    }

    protected init() {
        this.inited = true;
        this.nativeUnsub = this.subscribeNative(this.publish.bind(this));
    }

    cleanup() {
        if (this.nativeUnsub) {
            try {
                this.unsubscribeNative(this.nativeUnsub);
            } catch (e) {
                this.logger.warn("取消底层订阅失败:", e);
            } finally {
                this.nativeUnsub = undefined;
            }
        }
        this.map.clear();
        this.totalCount = 0;
        this.inited = false;
    }

    private publish(event: TEvent) {
        if (!this.isTargetEvent(event)) return;
        const key = this.extractKey(event);
        if (key == null) return;

        const callbacks = this.map.get(key);
        if (!callbacks || callbacks.size === 0) return;

        //包装
        const eventWrapped = this.eventWrapper(event);

        for (const data of Array.from(callbacks)) {
            if (!this.filter(data, event)) continue;
            try {
                data.callback(eventWrapped);
            } catch (e) {
                this.logger.error("callback failed:", e);
            }
        }
    }

    /** 子类实现：如何从订阅 options 构造 key */
    protected abstract buildKey(options: TOptions): TKey | null;

    /** 子类实现：如何从订阅 options 构造 data */
    protected abstract buildData(
        callback: (event: TCustomEvent) => void,
        options: TOptions
    ): TData;

    /** 子类实现：如何从原生事件提取 key */
    protected abstract extractKey(event: TEvent): TKey | null;

    /** 子类可重写：是否为需要的事件 */
    protected isTargetEvent(event: TEvent): boolean {
        return true;
    }

    /**自定义事件返回 */
    protected eventWrapper(event: TEvent): TCustomEvent {
        return event as unknown as TCustomEvent;
    }

    /** 子类实现：是否触发回调 */
    protected abstract filter(data: TData, event: TEvent): boolean;

    /** 子类实现：订阅原生事件 */
    protected abstract subscribeNative(
        cb: (event: TEvent) => void
    ): (event: TEvent) => void;

    /** 子类实现：取消原生事件 */
    protected abstract unsubscribeNative(cb: (event: TEvent) => void): void;
}
