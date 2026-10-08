import { GamePlayer, PlayerSource } from "@begame/core/gamePlayer";
import { GameRegion } from "@begame/core/gameRegion/gameRegion";
import { GameState } from "@begame/core/gameState";
import { Duration } from "@begame/core/utils";
import {
    RegionBoundary,
    RegionBoundaryOptions,
} from "../region/regionBoundary";

interface PlayerRegionMonitorBase<P extends GamePlayer> {
    region: GameRegion;
    interval?: Duration;
    onLeave: (player: P) => void;
}

type PlayerRegionMonitorSource<P extends GamePlayer> =
    | {
          players: PlayerSource<P>;
          /** @deprecated 使用 players。 */
          groups?: PlayerSource<P>;
      }
    | {
          players?: PlayerSource<P>;
          /** @deprecated 使用 players。 */
          groups: PlayerSource<P>;
      };

export type PlayerRegionMonitorOptions<P extends GamePlayer> =
    PlayerRegionMonitorBase<P> & PlayerRegionMonitorSource<P>;

/**
 * @deprecated 使用 RegionBoundary + regionBoundary(options)。
 *
 * 这是旧 PlayerRegionMonitor 的真实兼容适配器：继续接受 groups，
 * 但底层完全委托给 RegionBoundary，不维护第二套区域状态机。
 */
export class PlayerRegionMonitor<
    P extends GamePlayer = GamePlayer
> extends RegionBoundary {
    constructor(
        state: GameState,
        options?: PlayerRegionMonitorOptions<P>,
        tag?: string
    ) {
        const source = options?.players ?? options?.groups;
        const mapped: RegionBoundaryOptions<P> | undefined =
            options && source
                ? {
                      region: options.region,
                      interval: options.interval,
                      players: source,
                      onLeave: (player) => options.onLeave(player),
                  }
                : undefined;

        super(state, mapped, tag);
    }
}
