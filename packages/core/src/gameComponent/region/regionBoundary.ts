import { GamePlayer, PlayerSource, resolvePlayerEntries } from "@begame/core/gamePlayer";
import { GameRegion } from "@begame/core/gameRegion/gameRegion";
import { GameState } from "@begame/core/gameState";
import { Game } from "@begame/core/main";
import { Duration } from "@begame/core/utils";
import { PlayerGroup } from "../../gamePlayer/playerGroup";
import { GameComponent } from "../gameComponent";

export interface RegionBoundaryOptions<
    P extends GamePlayer = GamePlayer,
    TData = any
> {
    /** 要约束的区域。玩家处于其他维度时视为区域外。 */
    region: GameRegion;
    /** 要监测的玩家来源。 */
    players: PlayerSource<P, TData>;
    /** 检测间隔，默认 10 tick。 */
    interval?: Duration;
    /** 玩家从区域外重新进入区域时触发。首次扫描位于区域内不会触发。 */
    onEnter?: (player: P, group?: PlayerGroup<P, TData>) => void;
    /**
     * 玩家离开区域时触发。
     * 首次扫描就位于区域外的玩家也会触发一次，之后保持区域外不会重复触发。
     */
    onLeave?: (player: P, group?: PlayerGroup<P, TData>) => void;
}

/**
 * 类型推导 helper。泛型 Component class 本身无法从 addComponent 的 options
 * 可靠反推 P/TData，因此像 playerInfoText 一样由 options helper 承担推导。
 */
export function regionBoundary<
    P extends GamePlayer = GamePlayer,
    TData = any
>(
    options: RegionBoundaryOptions<P, TData>
): RegionBoundaryOptions<P, TData> {
    return options;
}

/**
 * 针对一个 PlayerSource 的区域边界观察器。
 *
 * 与 Game.events.region 的“全服玩家进入某区域”不同，本组件用于已经属于某个
 * 游戏/队伍的玩家集合：来源变化会在下一次扫描自然纳入，不需要额外注册。
 */
export class RegionBoundary extends GameComponent<
    GameState,
    RegionBoundaryOptions<any, any>
> {
    private readonly insideById = new Map<string, boolean>();

    override onAttach(): void {
        if (!this.options) return;
        this.subscribe(
            Game.events.interval,
            () => this.refresh(),
            this.options.interval ?? new Duration(10)
        );
    }

    override onDetach(): void {
        this.insideById.clear();
    }

    /** 立即同步一次边界状态。 */
    refresh() {
        const options = this.options;
        if (!options) return;

        const aliveIds = new Set<string>();

        for (const { player, group } of resolvePlayerEntries(options.players)) {
            const nativePlayer = player.player;
            if (!nativePlayer) continue;

            aliveIds.add(player.id);
            const inside =
                nativePlayer.dimension.id === options.region.dimensionId &&
                options.region.isInside(nativePlayer.location);
            const previous = this.insideById.get(player.id);

            if (previous === undefined) {
                this.insideById.set(player.id, inside);
                if (!inside) options.onLeave?.(player, group);
                continue;
            }
            if (previous === inside) continue;

            this.insideById.set(player.id, inside);
            if (inside) options.onEnter?.(player, group);
            else options.onLeave?.(player, group);
        }

        // 玩家离开 PlayerSource 后忘记旧状态；再次加入时重新建立基线。
        for (const id of [...this.insideById.keys()]) {
            if (!aliveIds.has(id)) this.insideById.delete(id);
        }
    }
}
