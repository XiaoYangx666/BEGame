import { GameMode } from "@minecraft/server";
import {
    PlayerRegionEvent,
    RegionEventType,
} from "@begame/core/gameEvent/events/regionEvents";
import { Game } from "@begame/core/main";
import { GamePlayer } from "../../gamePlayer/gamePlayer";
import { PlayerGroup } from "../../gamePlayer/playerGroup";
import { GameRegion } from "../../gameRegion/gameRegion";
import { GameState } from "../../gameState/gameState";
import { GameComponent } from "../gameComponent";

export interface RegionTeamChooserData<P extends GamePlayer> {
    /**指定范围 */
    region: GameRegion;
    /**玩家进入区域时执行 */
    onEnter?: (player: P) => void;
    /**玩家首次加入本队时执行 */
    onJoin?: (player: P) => void;
    /**指定队伍*/
    team: PlayerGroup<P>;
}

interface RegionTeamChooserConfig<P extends GamePlayer> {
    config: RegionTeamChooserData<P>[];
    /**当玩家离开单个选队区域时是否从该队删除(默认否) */
    removeOnLeave?: boolean;
    /**
     * 可选的整个选队/等待大厅范围。
     * 玩家离开该范围时会从本 Chooser 管理的所有队伍删除。
     */
    membershipRegion?: GameRegion;
    /**是否允许旁观者进队(默认否) */
    allowSpectator?: boolean;
}

/**区域队伍选择器 */
export class RegionTeamChooser<
    P extends GamePlayer,
    S extends GameState<P, any> = GameState<P, any>
> extends GameComponent<S, RegionTeamChooserConfig<P>> {
    override onAttach() {
        if (!this.options) return;
        this.options.config.forEach((data) => {
            this.subscribe(
                Game.events.region,
                (event) => this.handleRegionEvent(event, data),
                data.region
            );
        });

        if (this.options.membershipRegion) {
            this.subscribe(
                Game.events.region,
                (event) => this.handleMembershipRegionEvent(event),
                this.options.membershipRegion
            );
        }
    }

    private handleRegionEvent(
        event: PlayerRegionEvent,
        data: RegionTeamChooserData<P>
    ) {
        // Leave 只能清理已有队伍关系，绝不能因为“离开区域”反向创建 participation。
        if (event.type === RegionEventType.Leave) {
            if (this.options?.removeOnLeave ?? false) {
                data.team.delete(event.player, "region-leave");
            }
            return;
        }
        if (event.type !== RegionEventType.Enter) return;

        // 旁观者校验必须发生在 join 前，否则虽然不会进队，仍会错误占用 participation。
        if (
            !(this.options?.allowSpectator ?? false) &&
            event.player.getGameMode() === GameMode.Spectator
        ) {
            return;
        }

        // 区域选择器本身就是“加入游戏”的入口，因此只在真正 Enter 时显式 join。
        const joined = this.state.playerManager.join(event.player);
        if (!joined.allowed) {
            if (event.player.isValid) {
                event.player.sendMessage("暂时无法进入队伍");
            }
            return;
        }

        this.handlePlayerEnter(joined.player, data);
    }

    private handleMembershipRegionEvent(event: PlayerRegionEvent) {
        if (event.type !== RegionEventType.Leave) return;
        const seen = new Set<PlayerGroup<P>>();
        for (const data of this.options?.config ?? []) {
            if (seen.has(data.team)) continue;
            seen.add(data.team);
            data.team.delete(event.player, "membership-region-leave");
        }
    }

    private handlePlayerEnter(
        gamePlayer: P,
        configData: RegionTeamChooserData<P>
    ) {
        const newTeam = configData.team;
        const alreadyInTeam = newTeam.has(gamePlayer);
        configData.onEnter?.(gamePlayer);

        this.options?.config.forEach((d) => {
            if (d.team !== newTeam) {
                d.team.delete(gamePlayer);
            }
        });

        newTeam.add(gamePlayer);
        if (!alreadyInTeam) {
            configData.onJoin?.(gamePlayer);
        }
    }

    override onDetach(): void {
        super.onDetach();
        if (this.options) {
            this.options.config.forEach((t) => t.team.clearInvalid());
        }
    }
}
