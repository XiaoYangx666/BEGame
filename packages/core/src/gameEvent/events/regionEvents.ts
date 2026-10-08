import { Player } from "@minecraft/server";
import { GameRegion } from "@begame/core/gameRegion/gameRegion";
import { gameServer } from "@begame/core/system/server";
import { difference } from "@begame/core/utils/func";
import { Logger } from "@begame/core/utils/logger";
import { DimensionIds } from "@begame/core/utils/vanila-data";
import { CustomEventSignal } from "../eventSignal";
import { Subscription } from "../subscription";
import { IntervalEventSignal } from "./interval";

export enum RegionEventType {
    Enter = "enter",
    Leave = "leave",
}

export interface PlayerRegionEvent {
    readonly player: Player;
    readonly type: RegionEventType;
    readonly region: GameRegion;
}

interface RegionSubscription {
    callback: (event: PlayerRegionEvent) => void;
    region: GameRegion;
}

export class PlayerRegionEventSignal
    implements CustomEventSignal<PlayerRegionEvent>
{
    constructor(private readonly tickEvent: IntervalEventSignal) {}
    private logger = new Logger(this.constructor.name);
    private subscription: Subscription | null = null;

    private allSubscriptions: Set<RegionSubscription> = new Set();

    // 每个 region 当前的玩家状态
    private regionStates: Map<GameRegion, Set<string>> = new Map();

    subscribe(
        callback: (event: PlayerRegionEvent) => void,
        region: GameRegion
    ): Subscription {
        const subscription: RegionSubscription = { callback, region };
        this.allSubscriptions.add(subscription);

        // 初始化状态
        if (!this.regionStates.has(region)) {
            this.regionStates.set(region, new Set());
        }

        if (this.subscription === null) {
            this.startMonitoring();
        }

        return {
            unsubscribe: () => {
                this.allSubscriptions.delete(subscription);
                // 如果 region 没有订阅者了，清理它的状态
                if (
                    ![...this.allSubscriptions].some(
                        (sub) => sub.region === region
                    )
                ) {
                    this.regionStates.delete(region);
                }

                if (this.allSubscriptions.size === 0) {
                    this.stopMonitoring();
                }
            },
        };
    }

    private startMonitoring(): void {
        this.logger.debug("启动玩家区域观测");
        this.subscription = this.tickEvent.subscribe(
            this.checkAllRegions.bind(this)
        );
    }

    private stopMonitoring(): void {
        if (this.subscription !== null) {
            this.logger.debug("停止玩家区域观测");
            this.subscription.unsubscribe();
            this.subscription = null;
            this.regionStates.clear();
        }
    }

    private checkAllRegions(): void {
        // 1. 按维度收集所有在线玩家
        const players = gameServer.getAllPlayers();
        const playersByDimension: Record<string, Player[]> = {};
        const dimensions = Object.values(DimensionIds);

        for (const dim of dimensions) {
            playersByDimension[dim] = players.filter(
                (p) => p.dimension.id === dim
            );
        }

        // 2. 每个 region 只计算一次状态变化，再广播给该 region 的全部订阅者。
        //    regionStates 是 region 级状态，不能在逐 subscription 循环里提前更新。
        const regions = new Set(
            [...this.allSubscriptions].map((sub) => sub.region)
        );
        for (const region of regions) {
            const prevPlayers =
                this.regionStates.get(region) ?? new Set<string>();
            const dimensionPlayers =
                playersByDimension[region.dimensionId] ?? [];
            const currPlayers = new Set(
                dimensionPlayers
                    .filter((p) => region.isInside(p.location))
                    .map((p) => p.id)
            );
            const subscriptions = [...this.allSubscriptions].filter(
                (sub) => sub.region === region
            );

            for (const playerId of difference(currPlayers, prevPlayers)) {
                const player = dimensionPlayers.find((p) => p.id === playerId);
                if (!player) continue;
                for (const sub of subscriptions) {
                    this.publish(player, RegionEventType.Enter, sub);
                }
            }

            for (const playerId of difference(prevPlayers, currPlayers)) {
                const player = players.find((p) => p.id === playerId);
                if (!player) continue;
                for (const sub of subscriptions) {
                    this.publish(player, RegionEventType.Leave, sub);
                }
            }

            this.regionStates.set(region, currPlayers);
        }
    }

    private publish(
        player: Player,
        type: RegionEventType,
        subscription: RegionSubscription
    ): void {
        try {
            subscription.callback({
                player,
                type,
                region: subscription.region,
            });
        } catch (e) {
            this.logger.error("Region event callback error:", e);
        }
    }

    dispose(): void {
        this.stopMonitoring();
        this.allSubscriptions.clear();
    }
}
