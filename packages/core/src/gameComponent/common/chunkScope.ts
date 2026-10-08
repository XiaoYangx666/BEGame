import { Vector3, world } from "@minecraft/server";
import { Game, GameState } from "@begame/core/main";
import { Duration, Logger } from "@begame/core/utils";
import { DimensionIds } from "@begame/core/utils/vanila-data";
import { GameComponent, GameComponentType } from "../gameComponent";

export interface ChunkScopeOptions {
    /** 要检测的维度 */
    dimensionId: DimensionIds;
    /** 用于检测是否加载的方块坐标 */
    pos: Vector3;
    /** 加载时的回调（区块首次加载时触发） */
    onLoad: (scope: ChunkScope) => void;
    /** 卸载时的回调（区块卸载或 Scope 卸载时触发） */
    onUnload?: () => void;
    /** 检测间隔，默认 20 tick */
    interval?: Duration;
}

interface ChunkOwnedComponent {
    type: GameComponentType<any, any>;
    tag?: string;
}

/**
 * 将一组子组件的生命周期绑定到某个区块探测点是否可访问。
 *
 * onLoad 中通过 scope.addComponent() 创建的组件归 ChunkScope 所有：
 * 区块卸载、reload 或 ChunkScope 自身卸载时都会按逆序清理。
 */
export class ChunkScope extends GameComponent<
    GameState<any, any>,
    ChunkScopeOptions
> {
    private active = false;
    private readonly logger = new Logger(this.constructor.name);
    private components: ChunkOwnedComponent[] = [];

    get isActive() {
        return this.active;
    }

    override onAttach(): void {
        if (!this.options) return;
        this.subscribe(
            Game.events.interval,
            () => this.syncLoadedState(),
            this.options.interval ?? new Duration(20)
        );
    }

    override onDetach(): void {
        this.deactivate();
    }

    private syncLoadedState() {
        if (!this.options) return;
        const block = world
            .getDimension(this.options.dimensionId)
            .getBlock(this.options.pos);

        if (block) {
            if (!this.active) this.activate(false);
        } else if (this.active) {
            this.deactivate();
        }
    }

    /**
     * 激活 Scope。
     * onLoad 失败时回滚本次已创建的全部子组件，并保持 inactive，
     * 因此后续检测可以自然重试。
     */
    private activate(throwOnError: boolean) {
        if (!this.options || this.active) return;
        this.logger.log("load");

        try {
            this.options.onLoad(this);
            this.active = true;
        } catch (err) {
            let cleanupError: unknown;
            try {
                this.clearComponents();
            } catch (cleanupErr) {
                cleanupError = cleanupErr;
            }
            this.active = false;

            const error =
                cleanupError === undefined
                    ? err
                    : new AggregateError(
                          [err, cleanupError],
                          "ChunkScope onLoad 失败且回滚子组件时发生错误"
                      );
            if (throwOnError) throw error;
            this.logger.error("onLoad error:", error);
        }
    }

    private deactivate() {
        const wasActive = this.active;
        const hasChildren = this.components.length > 0;
        if (!wasActive && !hasChildren) return;

        this.logger.log("unload");
        this.active = false;

        const errors: unknown[] = [];
        try {
            this.clearComponents();
        } catch (err) {
            errors.push(err);
        }

        if (wasActive) {
            try {
                this.options?.onUnload?.();
            } catch (err) {
                errors.push(err);
            }
        }

        if (errors.length > 0) {
            throw new AggregateError(errors, "ChunkScope 卸载失败");
        }
    }

    private clearComponents() {
        // 子组件按创建顺序的逆序释放，更符合资源依赖关系。
        const components = this.components;
        this.components = [];

        const errors: unknown[] = [];
        for (const { type, tag } of components.reverse()) {
            try {
                this.state.deleteComponent(type, tag);
            } catch (err) {
                errors.push(err);
            }
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, "ChunkScope 子组件清理失败");
        }
    }

    /** 强制重新执行一次 unload -> load。 */
    reload() {
        if (!this.options) return this;
        this.deactivate();
        this.activate(true);
        return this;
    }

    addComponent<C extends GameComponentType<any, any>>(
        component: C,
        options?: ConstructorParameters<C>[1],
        tag?: string
    ): this;
    addComponent<O, C extends GameComponentType<any, O>>(
        component: C,
        options?: O,
        tag?: string
    ): this;
    addComponent(
        component: GameComponentType<any, any>,
        options?: any,
        tag?: string
    ) {
        this.state.addComponent(component, options, tag);
        // 只有 addComponent 完整成功后才登记所有权。
        this.components.push({ type: component, tag });
        return this;
    }
}
