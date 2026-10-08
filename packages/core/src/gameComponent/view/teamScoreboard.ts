import { GamePlayer, PlayerGroup } from "@begame/core/gamePlayer";
import { GameState } from "@begame/core/gameState";
import {
    SidebarScoreboard,
    SidebarScoreboardOptions,
} from "./infoScoreboard";

export interface TeamScoreboardTeamData<T extends GamePlayer = GamePlayer> {
    team: PlayerGroup<T>;
    prefix?: string;
    buildName?: (player: T) => string;
    teamSort?: (p1: T, p2: T) => number;
    teamFilter?: (p: T) => boolean;
    showInvalid?: boolean;
}

export interface TeamScoreboardOptions<P extends GamePlayer> {
    scoreboardName: string;
    displayName: string;
    teams: TeamScoreboardTeamData<P>[];
    showOnAttach?: boolean;
}

/**
 * 队伍侧边栏 preset。
 *
 * 只是把 PlayerGroup[] 转成 SidebarScoreboard 的 lines/refreshOn，
 * 不再拥有独立 Component 生命周期。
 */
export function teamScoreboard<P extends GamePlayer>(
    options: TeamScoreboardOptions<P>
): SidebarScoreboardOptions {
    const teams = [...new Set(options.teams.map((item) => item.team))];

    return {
        scoreboardName: options.scoreboardName,
        displayName: options.displayName,
        showOnAttach: options.showOnAttach,
        refreshOn: teams.map((team) => team.changed),
        // 保留旧 TeamScoreBoard 的可见排序：score 随 index 增长。
        score: (index) => index,
        lines: () => {
            const scores: string[] = [];

            for (const team of options.teams) {
                let players = team.team.getAll();

                if (team.teamFilter) {
                    players = players.filter(team.teamFilter);
                }
                if (team.teamSort) {
                    players.sort(team.teamSort);
                }

                for (const player of players) {
                    if (!(team.showInvalid ?? false) && !player.isValid) {
                        continue;
                    }
                    scores.push(
                        team.buildName
                            ? team.buildName(player)
                            : (team.prefix ?? "") + player.name
                    );
                }
            }

            return scores;
        },
    };
}

/**
 * @deprecated 使用 SidebarScoreboard + teamScoreboard(options)。
 * 这里只保留薄兼容壳，不再维护第二套 scoreboard 实现。
 */
export class TeamScoreBoard<
    P extends GamePlayer
> extends SidebarScoreboard {
    constructor(
        state: GameState<P>,
        options?: TeamScoreboardOptions<P>,
        tag?: string
    ) {
        super(state, options ? teamScoreboard(options) : undefined, tag);
    }

    refreshScoreBoard() {
        this.refresh();
    }
}


/** @deprecated 使用 TeamScoreboardTeamData。 */
export type TeamScoreBoardTeamData<T extends GamePlayer = GamePlayer> =
    TeamScoreboardTeamData<T>;

/** @deprecated 使用 TeamScoreboardOptions。 */
export type TeamScoreBoardOptions<P extends GamePlayer> =
    TeamScoreboardOptions<P>;
