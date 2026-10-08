import { GameState } from "@begame/core/gameState/gameState";
import { Game } from "@begame/core/main";
import { BuiltinTraceEventType } from "../../../trace/contract";
import { GameComponent } from "../../gameComponent";
import { TimerOnTimeEventSignal } from "./onTimeEvent";
import { TimerTickEventSignal } from "./tickEvent";

export interface TimerOptions {
    initialTime?: number;
    autoStart?: boolean;
    compensate?: boolean;
}

export class Timer extends GameComponent<GameState<any>, TimerOptions> {
    private remainingTime = 0;
    private _isRunning = false;
    private lastTime = 0;

    public readonly events = {
        tick: new TimerTickEventSignal(),
        onTime: new TimerOnTimeEventSignal(),
    } as const;

    public get time(): Readonly<number> {
        return this.remainingTime;
    }

    public get isRunning(): Readonly<boolean> {
        return this._isRunning;
    }

    override onAttach(): void {
        this.set(this.options?.initialTime ?? 0);

        this.subscribe(Game.events.interval, () => {
            if (!this._isRunning) return;

            const now = Date.now();
            const diff = now - this.lastTime;
            if (diff < 1000) return;

            const steps = this.options?.compensate
                ? Math.floor(diff / 1000)
                : 1;
            this.lastTime = this.options?.compensate
                ? this.lastTime + steps * 1000
                : now;
            this.advance(steps);
        });

        if (this.options?.autoStart) {
            this.start();
        }
    }

    override onDetach(): void {
        if (this._isRunning) {
            this.trace.builtin(BuiltinTraceEventType.TimerCancelled, {
                reason: "component-detach",
                remainingTime: this.remainingTime,
            });
        }
        this._isRunning = false;
        super.onDetach();
        this.state.eventManager.unsubscribeByEvent(this.events.onTime);
        this.state.eventManager.unsubscribeByEvent(this.events.tick);
    }

    /** 设置当前时间；运行中设置为 0 会立即按“到期”语义结束。 */
    public set(time: number): void {
        const next = Math.max(0, time);
        this.remainingTime = next;
        this.lastTime = Date.now();

        if (next === 0 && this._isRunning) {
            this.expire();
            this.publishTime(0);
        }
    }

    public stop(reason = "manual"): void {
        if (this._isRunning) {
            this.trace.builtin(BuiltinTraceEventType.TimerCancelled, {
                reason,
                remainingTime: this.remainingTime,
            });
        }
        this._isRunning = false;
    }

    public start(): void {
        if (this.remainingTime <= 0 || this._isRunning || !this.isAttached) {
            return;
        }

        this._isRunning = true;
        this.lastTime = Date.now();
        this.trace.builtin(BuiltinTraceEventType.TimerStarted, {
            remainingTime: this.remainingTime,
            compensate: this.options?.compensate ?? false,
        });

        const current = this.remainingTime;
        this.publishTime(current);
    }

    private advance(steps: number): void {
        if (steps <= 0 || !this._isRunning) return;

        const count = Math.min(steps, this.remainingTime);
        for (let i = 0; i < count && this._isRunning; i++) {
            const current = Math.max(0, this.remainingTime - 1);
            this.remainingTime = current;

            if (current === 0) {
                this.expire();
            }
            this.publishTime(current);
        }
    }

    /**
     * 使用当前这一步的快照值发事件，避免 tick 回调里的 set()/stop()
     * 改变随后 onTime 应观察到的秒值。
     */
    private publishTime(time: number) {
        this.events.tick.publish(time);
        this.events.onTime.checkAndFireTimeEvents(time);
    }

    private expire() {
        if (!this._isRunning) return;
        this._isRunning = false;
        this.trace.builtin(BuiltinTraceEventType.TimerExpired, {
            remainingTime: 0,
        });
    }
}
