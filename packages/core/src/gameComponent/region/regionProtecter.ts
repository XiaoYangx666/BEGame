import {
    PlayerBreakBlockBeforeEvent,
    PlayerInteractWithBlockBeforeEvent,
    world,
} from "@minecraft/server";
import {
    PlayerGroupSet,
    PlayerSource,
    playerSourceHas,
} from "@begame/core/gamePlayer";
import { GameRegion } from "@begame/core/gameRegion/gameRegion";
import { GameState } from "@begame/core/gameState";
import { GameComponent } from "../gameComponent";

export interface RegionProtectionOptions {
    /** 需要保护的区域 */
    region: GameRegion;
    /** 是否阻止区域内方块被破坏 */
    blockBreakInside?: boolean;
    /** 是否阻止区域内方块被交互 */
    blockInteractInside?: boolean;
    /** 是否阻止区域外方块被破坏 */
    blockBreakOutside?: boolean;
    /** 是否阻止区域外方块被交互 */
    blockInteractOutside?: boolean;
    /** 生效的玩家来源；不设置则对所有玩家生效。 */
    players?: PlayerSource<any>;
    /** @deprecated 使用 players。 */
    groupSet?: PlayerGroupSet<any>;
}

export class RegionProtector extends GameComponent<
    GameState,
    RegionProtectionOptions
> {
    protected override onAttach(): void {
        if (!this.options) return;

        if (this.options.blockBreakInside || this.options.blockBreakOutside) {
            this.subscribe(world.beforeEvents.playerBreakBlock, (event) => {
                if (!this.appliesToPlayer(event.player.id)) return;
                this.handleBreak(event);
            });
        }

        if (
            this.options.blockInteractOutside ||
            this.options.blockInteractInside
        ) {
            this.subscribe(
                world.beforeEvents.playerInteractWithBlock,
                (event) => {
                    if (!this.appliesToPlayer(event.player.id)) return;
                    this.handleInteract(event);
                }
            );
        }
    }

    private appliesToPlayer(playerId: string) {
        const source = this.options?.players ?? this.options?.groupSet;
        return source === undefined || playerSourceHas(source, playerId);
    }

    private isInsideRegion(
        block: PlayerBreakBlockBeforeEvent["block"] |
            PlayerInteractWithBlockBeforeEvent["block"]
    ) {
        const region = this.options!.region;
        return (
            block.dimension.id === region.dimensionId &&
            region.isBlockInside(block.location)
        );
    }

    private handleBreak(event: PlayerBreakBlockBeforeEvent) {
        const inside = this.isInsideRegion(event.block);
        if (
            (inside && this.options!.blockBreakInside) ||
            (!inside && this.options!.blockBreakOutside)
        ) {
            event.cancel = true;
        }
    }

    private handleInteract(event: PlayerInteractWithBlockBeforeEvent) {
        const inside = this.isInsideRegion(event.block);
        if (
            (inside && this.options!.blockInteractInside) ||
            (!inside && this.options!.blockInteractOutside)
        ) {
            event.cancel = true;
        }
    }
}
