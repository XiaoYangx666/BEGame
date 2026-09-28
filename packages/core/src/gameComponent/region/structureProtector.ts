import {
    BlockPermutation,
    PlayerBreakBlockBeforeEvent,
    PlayerInteractWithBlockBeforeEvent,
    PlayerPlaceBlockAfterEvent,
    Vector3,
    world,
} from "@minecraft/server";
import { CubeRegion, GameRegion } from "@sapi-game/gameRegion/gameRegion";
import { playerSourceHas, type PlayerSource } from "@sapi-game/gamePlayer";
import { GameState } from "@sapi-game/gameState";
import { GameStructure } from "@sapi-game/gameStructure/gameStructure";
import {
    StructureBlockMask,
    structureBlockMasks,
} from "@sapi-game/gameStructure/structureBlockMask";
import { Logger } from "@sapi-game/utils";
import { GameComponent } from "../gameComponent";

export interface StructureProtectorOptions {
    /** 受保护的结构（结构 id、放置原点、维度）。 */
    structure: GameStructure;
    /**
     * 已经扫描好的位图。省略时组件会用 `structure` 自行扫描（异步、分批，
     * 扫描完成前不提供保护）；提供时立即生效并触发 onReady。
     */
    mask?: StructureBlockMask;
    /** 位图就绪回调（无论自带还是自扫描都会触发一次）。 */
    onReady?: (mask: StructureBlockMask) => void;
    /**
     * 需要托管的区域，默认是结构体积本身。区域用于限制「附加规则」的
     * 作用范围；原始结构方块无论在不在区域内都受保护。
     */
    region?: GameRegion;
    /** 生效的玩家来源；不设置则对所有玩家生效。 */
    players?: PlayerSource<any>;
    /** 阻止破坏原始结构方块，默认 true。 */
    protectBreak?: boolean;
    /** 阻止覆盖原始结构方块的放置，默认 true。 */
    protectPlace?: boolean;
    /** 阻止与原始结构方块/托管区域内的方块交互，默认 false。 */
    blockInteract?: boolean;
    /** 附加破坏判定：返回 false 时取消破坏（在托管区域内生效）。 */
    allowBreak?: (location: Vector3, playerId: string) => boolean;
    /** 附加放置判定：返回 false 时回滚放置（在托管区域内生效）。 */
    allowPlace?: (
        location: Vector3,
        playerId: string,
        itemTypeId?: string
    ) => boolean;
    /** 回滚覆盖原图方块时是否还原原方块，默认 true；false 则置为空气。 */
    restoreOriginal?: boolean;
}

/** 类型推导 helper，用法与 regionBoundary 一致。 */
export function structureProtector(
    options: StructureProtectorOptions
): StructureProtectorOptions {
    return options;
}

/**
 * 通用地图方块保护组件。
 *
 * - 原始结构方块（mcstructure 里的非空气方块）不可破坏、不可被覆盖；
 * - 覆盖原图的放置会在后置事件里回滚（还原原方块或空气）；
 * - 可通过 `allowBreak` / `allowPlace` 接入游戏自己的规则（队伍、建造范围等）；
 * - `region` 用来限定附加规则的作用范围，默认结构体积。
 *
 * 位图按 structureId 全局缓存，同结构的多个房间只扫描一次。
 */
export class StructureProtector extends GameComponent<
    GameState<any, any>,
    StructureProtectorOptions
> {
    private scanned?: StructureBlockMask;
    private scanJobId?: string;
    private readonly logger = new Logger("StructureProtector");

    /** 当前可用的位图；扫描完成前为 undefined。 */
    get mask(): StructureBlockMask | undefined {
        return this.scanned ?? this.options?.mask;
    }

    get isReady(): boolean {
        return this.mask !== undefined;
    }

    override onAttach(): void {
        const options = this.options;
        if (!options) return;

        if (options.mask) {
            this.scanned = options.mask;
            options.onReady?.(options.mask);
        } else {
            this.startScan();
        }

        if (options.protectBreak !== false || options.allowBreak) {
            this.subscribe(world.beforeEvents.playerBreakBlock, (event) =>
                this.handleBreak(event)
            );
        }
        if (options.protectPlace !== false || options.allowPlace) {
            this.subscribe(world.afterEvents.playerPlaceBlock, (event) =>
                this.handlePlace(event)
            );
        }
        if (options.blockInteract) {
            this.subscribe(
                world.beforeEvents.playerInteractWithBlock,
                (event) => this.handleInteract(event)
            );
        }
    }

    override onDetach(): void {
        if (this.scanJobId) {
            this.runner.cancel(this.scanJobId, "structure-protector-detach");
            this.scanJobId = undefined;
        }
        this.scanned = undefined;
    }

    private startScan(): void {
        const options = this.options;
        if (!options) return;
        const template = world.structureManager.get(options.structure.id);
        if (!template) {
            this.logger.error(
                "结构资源不存在，无法扫描保护位图：" + options.structure.id
            );
            return;
        }
        const { id, promise } = this.runner.runJob(
            structureBlockMasks.scan(template, (mask) => {
                if (!this.isAttached) return;
                this.scanned = mask;
                this.options?.onReady?.(mask);
            })
        );
        this.scanJobId = id;
        promise.catch((error) => {
            this.logger.error(
                "结构保护位图扫描失败：" + options.structure.id,
                error
            );
        });
    }

    private appliesToPlayer(playerId: string): boolean {
        const source = this.options?.players;
        return source === undefined || playerSourceHas(source, playerId);
    }

    private isOriginal(location: Vector3): boolean {
        const options = this.options;
        const mask = this.mask;
        return (
            !!options && !!mask &&
            mask.hasWorldBlock(location, options.structure.loc)
        );
    }

    private managedRegion(): GameRegion | undefined {
        const options = this.options;
        if (!options) return undefined;
        if (options.region) return options.region;
        const mask = this.mask;
        if (!mask) return undefined;
        const { x, y, z } = options.structure.loc;
        return new CubeRegion(
            options.structure.dim,
            { x, y, z },
            {
                x: x + mask.size.x - 1,
                y: y + mask.size.y - 1,
                z: z + mask.size.z - 1,
            }
        );
    }

    private inManagedRegion(location: Vector3): boolean {
        const region = this.managedRegion();
        return !!region && region.isBlockInside(location);
    }

    private handleBreak(event: PlayerBreakBlockBeforeEvent): void {
        const options = this.options;
        if (!options || !this.mask) return;
        if (event.block.dimension.id !== options.structure.dim) return;
        if (!this.appliesToPlayer(event.player.id)) return;

        const location = event.block.location;
        if (this.isOriginal(location)) {
            if (options.protectBreak !== false) event.cancel = true;
            return;
        }
        if (
            options.allowBreak &&
            this.inManagedRegion(location) &&
            !options.allowBreak(location, event.player.id)
        ) {
            event.cancel = true;
        }
    }

    private handlePlace(event: PlayerPlaceBlockAfterEvent): void {
        const options = this.options;
        if (!options || !this.mask) return;
        if (event.dimension.id !== options.structure.dim) return;
        if (!this.appliesToPlayer(event.player.id)) return;

        const location = event.block.location;
        if (this.isOriginal(location)) {
            if (options.protectPlace !== false) this.rollback(event);
            return;
        }
        if (
            options.allowPlace &&
            this.inManagedRegion(location) &&
            !options.allowPlace(location, event.player.id, event.block.typeId)
        ) {
            this.rollback(event);
        }
    }

    private handleInteract(event: PlayerInteractWithBlockBeforeEvent): void {
        const options = this.options;
        if (!options || !this.mask) return;
        if (event.block.dimension.id !== options.structure.dim) return;
        if (!this.appliesToPlayer(event.player.id)) return;
        const location = event.block.location;
        if (this.isOriginal(location) || this.inManagedRegion(location)) {
            event.cancel = true;
        }
    }

    private rollback(event: PlayerPlaceBlockAfterEvent): void {
        const options = this.options;
        if (!options) return;
        const location = event.block.location;
        try {
            if (options.restoreOriginal !== false && this.isOriginal(location)) {
                const template = world.structureManager.get(options.structure.id);
                const relative = {
                    x: location.x - options.structure.loc.x,
                    y: location.y - options.structure.loc.y,
                    z: location.z - options.structure.loc.z,
                };
                const permutation = template?.getBlockPermutation(relative);
                if (permutation) {
                    event.block.setPermutation(
                        permutation as unknown as BlockPermutation
                    );
                    return;
                }
            }
            event.block.setPermutation(BlockPermutation.resolve("minecraft:air"));
        } catch (error) {
            // 区块卸载/实体失效等：交给上层的地图重置兜底，不在这里抛错。
            this.trace.debug("structure-protector.rollback.failed", {
                location: `${location.x},${location.y},${location.z}`,
            });
        }
    }
}
