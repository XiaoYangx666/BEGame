import {
    Dimension,
    StructurePlaceOptions,
    Vector3,
    world,
} from "@minecraft/server";
import { DimensionIds } from "@begame/core/utils/vanila-data";

/**游戏结构 */
export class GameStructure {
    readonly id: string;
    readonly dim: DimensionIds;
    readonly loc: Vector3;

    /**
     * 构造一个游戏结构
     * @param id 结构id
     * @param loc 结构放置坐标
     * @param dim 结构维度(默认主世界)
     */
    constructor(
        id: string,
        loc: Vector3,
        dim: DimensionIds = DimensionIds.Overworld
    ) {
        this.id = id;
        this.dim = dim;
        this.loc = loc;
    }

    /**获取结构 */
    get() {
        return world.structureManager.get(this.id);
    }

    /**放在默认的位置 */
    place(options?: StructurePlaceOptions) {
        const dim = world.getDimension(this.dim);
        world.structureManager.place(this.id, dim, this.loc, options);
    }

    /**放在指定地点 */
    placeOn(loc: Vector3, dim: Dimension, options?: StructurePlaceOptions) {
        world.structureManager.place(this.id, dim, loc, options);
    }
}
