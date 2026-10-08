import { GameState } from "@begame/core/gameState/gameState";
import { Game } from "@begame/core/main";
import { GameComponent } from "../../gameComponent";
import { StopWatchOnTimeEventSignal } from "./onTimeEvent";
import { StopWatchTickEventSignal } from "./tickEvent";

export interface StopWatchOptions {
    autoStart?: boolean;
    compensate?: boolean;
    initialTime?: number;
}

export class StopWatch extends GameComponent<GameState<any>, StopWatchOptions> {
    private elapsedTime = 0;
    private _isRunning = false;
    private lastTime = 0;
    private isActive = true;

    public readonly events = {
        tick: new StopWatchTickEventSignal(),
        onTime: new StopWatchOnTimeEventSignal(),
    } as const;

    public get time(): Readonly<number> {
        return this.elapsedTime;
    }

    public get isRunning(): Readonly<boolean> {
        return this._isRunning;
    }

    override onAttach(): void {
        this.isActive = true;
        this.elapsedTime = Math.max(0, this.options?.initialTime ?? 0);

        if (this.options?.autoStart) {
            this.start();
        }

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
    }

    override onDetach(): void {
        this._isRunning = false;
        this.isActive = false;
        super.onDetach();
        this.state.eventManager.unsubscribeByEvent(this.events.onTime);
        this.state.eventManager.unsubscribeByEvent(this.events.tick);
    }

    public reset(time = 0): void {
        this.elapsedTime = Math.max(0, time);
        this.lastTime = Date.now();
        if (this._isRunning) {
            const current = this.elapsedTime;
            this.events.tick.publish(current);
        }
    }

    public stop(): void {
        this._isRunning = false;
    }

    public start(): void {
        if (!this._isRunning && this.isActive) {
            this._isRunning = true;
            this.lastTime = Date.now();

            const current = this.elapsedTime;
            this.events.tick.publish(current);
            this.events.onTime.checkAndFireTimeEvents(current);
        }
    }

    public toggle(): void {
        this._isRunning ? this.stop() : this.start();
    }

    private advance(steps: number): void {
        for (let i = 0; i < steps && this._isRunning; i++) {
            const current = this.elapsedTime + 1;
            this.elapsedTime = current;
            this.events.tick.publish(current);
            this.events.onTime.checkAndFireTimeEvents(current);
        }
    }
}
