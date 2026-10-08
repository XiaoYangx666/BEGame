import { EventSignal } from "@begame/core/gameEvent/eventSignal";
import { GameState } from "@begame/core/gameState/gameState";
import { GameComponent } from "../gameComponent";
import {
    SidebarScoreResolver,
    SidebarScoreboardView,
} from "./sidebarScoreboard";

export interface SidebarScoreboardOptions {
    /** 推荐的新命名。 */
    scoreboardName?: string;
    /** @deprecated 使用 scoreboardName。 */
    scoreBoardName?: string;
    /** 计分板显示名字。 */
    displayName: string;
    /** 内容的左侧边距。 */
    paddingLeft?: number;
    /** 头部。 */
    header?: () => readonly string[];
    /** 底部。 */
    footer?: () => readonly string[];
    /** 是否立即显示计分板，默认 false。 */
    showOnAttach?: boolean;
    /** 可选的声明式内容来源；refresh()/show() 时会重新计算。 */
    lines?: () => readonly string[];
    /** 这些事件触发后自动刷新；同一批变化会合并到下一 tick。 */
    refreshOn?: readonly EventSignal<any>[];
    /** 分数映射；默认第一行显示在最上方。 */
    score?: SidebarScoreResolver;
}

/** @deprecated 使用 SidebarScoreboardOptions。 */
export type infoScoreboardOptions = SidebarScoreboardOptions;

/**
 * 通用 Sidebar Component。
 *
 * 既支持 updateLines() 的命令式更新，也支持 lines + refreshOn 的声明式更新。
 */
export class SidebarScoreboard extends GameComponent<
    GameState,
    SidebarScoreboardOptions
> {
    private view?: SidebarScoreboardView;
    private currentLines: readonly string[] = [];
    private pendingRefresh?: string;

    override onAttach(): void {
        if (!this.options) {
            throw new Error("SidebarScoreboard 缺少 options");
        }

        const objectiveId =
            this.options.scoreboardName ?? this.options.scoreBoardName;
        if (!objectiveId) {
            throw new Error("SidebarScoreboard requires scoreboardName");
        }

        this.view = new SidebarScoreboardView(
            objectiveId,
            this.options.displayName
        );
        this.view.clear();

        for (const signal of this.options.refreshOn ?? []) {
            this.subscribe(signal, () => this.requestRefresh());
        }

        if (this.options.showOnAttach) {
            this.show();
        } else if (this.options.lines) {
            this.refresh();
        }
    }

    override onDetach(): void {
        if (this.pendingRefresh !== undefined) {
            this.runner.cancel(
                this.pendingRefresh,
                "sidebar-scoreboard-detach"
            );
            this.pendingRefresh = undefined;
        }
        this.view?.dispose();
        this.view = undefined;
    }

    /** 显示，并在存在声明式 lines 时先同步最新内容。 */
    show() {
        if (this.options?.lines) this.refresh();
        this.view?.show();
    }

    /** 隐藏但保留当前内容。 */
    hide() {
        this.view?.hide();
    }

    /** 重新执行声明式 lines；没有 lines provider 时重新渲染当前内容。 */
    refresh() {
        if (this.options?.lines) {
            this.currentLines = [...this.options.lines()];
        }
        this.render();
    }

    /** 命令式更新；隐藏状态下也会保存并更新 objective。 */
    updateLines(lines: readonly string[]) {
        this.currentLines = [...lines];
        this.render();
    }

    private requestRefresh() {
        if (this.pendingRefresh !== undefined) return;
        this.pendingRefresh = this.runner.runDelay(() => {
            this.pendingRefresh = undefined;
            this.refresh();
        }, 1);
    }

    private render() {
        if (!this.options || !this.view) return;

        const padding = " ".repeat(this.options.paddingLeft ?? 0);
        const body = this.currentLines.map((line) => padding + line);
        const rendered = [
            ...(this.options.header?.() ?? []),
            ...body,
            ...(this.options.footer?.() ?? []),
        ];

        this.view.updateLines(
            rendered,
            this.options.score ?? ((index, total) => total - index - 1)
        );
    }
}

/** @deprecated 使用 SidebarScoreboard。 */
export { SidebarScoreboard as InfoScoreboard };
