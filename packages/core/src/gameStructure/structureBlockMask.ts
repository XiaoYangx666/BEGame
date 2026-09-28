import type { Vector3 } from "@minecraft/server";

/**
 * 结构模板的最小读取接口，用于把 mcstructure 里原本存在的非空气方块
 * 编码成只读占用位图。
 */
export interface StructureBlockReader {
    readonly id: string;
    readonly size: Vector3;
    getBlockPermutation(
        location: Vector3
    ): { readonly type: { readonly id: string } } | undefined;
}

const EMPTY_BLOCKS = new Set([
    "minecraft:air",
    "minecraft:cave_air",
    "minecraft:void_air",
    "minecraft:structure_void",
]);

function checkedSize(size: Vector3): Vector3 {
    if (
        !Number.isSafeInteger(size.x) ||
        !Number.isSafeInteger(size.y) ||
        !Number.isSafeInteger(size.z) ||
        size.x <= 0 ||
        size.y <= 0 ||
        size.z <= 0 ||
        !Number.isSafeInteger(size.x * size.y * size.z)
    ) {
        throw new Error("无效的结构尺寸");
    }
    return { ...size };
}

/**
 * 把结构里原本存在的非空气方块编码成只读占用位图。
 *
 * 仅存储方块是否属于原始结构，不保存材质和方块状态；不能用它恢复地图。
 * 要求以原始朝向、整数原点放置结构（没有旋转或镜像）。
 */
export class StructureBlockMask {
    readonly size: Readonly<Vector3>;
    readonly solidCount: number;

    constructor(
        size: Vector3,
        private readonly bits: Uint8Array,
        solidCount: number
    ) {
        this.size = checkedSize(size);
        if (bits.length !== Math.ceil((size.x * size.y * size.z) / 8)) {
            throw new Error("结构位图尺寸不匹配");
        }
        this.solidCount = solidCount;
    }

    get byteLength(): number {
        return this.bits.byteLength;
    }

    /** 相对于原始结构放置原点的方块位置，越界/非整数一律不命中。 */
    hasRelativeBlock(position: Vector3): boolean {
        const { x, y, z } = position;
        const size = this.size;
        if (
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            !Number.isInteger(z) ||
            x < 0 ||
            y < 0 ||
            z < 0 ||
            x >= size.x ||
            y >= size.y ||
            z >= size.z
        ) {
            return false;
        }
        const index = x + size.x * (z + size.z * y);
        return (this.bits[index >> 3] & (1 << (index & 7))) !== 0;
    }

    /** 世界方块位置 -> 结构相对位置；仅用于未旋转、未镜像的放置。 */
    hasWorldBlock(position: Vector3, origin: Vector3): boolean {
        return this.hasRelativeBlock({
            x: position.x - origin.x,
            y: position.y - origin.y,
            z: position.z - origin.z,
        });
    }
}

/**
 * 已完成的模板才能进入缓存。runJob 取消时生成器不会运行到最后，
 * 因此绝不会把扫描一半的位图发布给房间。
 */
export class StructureBlockMaskCache {
    private readonly masks = new Map<string, StructureBlockMask>();

    get(structureId: string): StructureBlockMask | undefined {
        return this.masks.get(structureId);
    }

    invalidate(structureId: string): void {
        this.masks.delete(structureId);
    }

    clear(): void {
        this.masks.clear();
    }

    *scan(
        structure: StructureBlockReader,
        onReady: (mask: StructureBlockMask) => void,
        batchSize = 2048
    ): Generator<void, void, void> {
        if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
            throw new Error("batchSize 必须为正整数");
        }

        const size = checkedSize(structure.size);
        const cached = this.masks.get(structure.id);
        if (cached) {
            if (
                cached.size.x !== size.x ||
                cached.size.y !== size.y ||
                cached.size.z !== size.z
            ) {
                throw new Error("同名结构尺寸已变化，请先使缓存失效");
            }
            onReady(cached);
            return;
        }

        const bits = new Uint8Array(Math.ceil((size.x * size.y * size.z) / 8));
        let index = 0;
        let solidCount = 0;

        for (let y = 0; y < size.y; y++) {
            for (let z = 0; z < size.z; z++) {
                for (let x = 0; x < size.x; x++) {
                    const permutation = structure.getBlockPermutation({ x, y, z });
                    if (permutation && !EMPTY_BLOCKS.has(permutation.type.id)) {
                        bits[index >> 3] |= 1 << (index & 7);
                        solidCount++;
                    }
                    index++;
                    if (index % batchSize === 0) yield;
                }
            }
        }

        const mask = new StructureBlockMask(size, bits, solidCount);
        this.masks.set(structure.id, mask);
        onReady(mask);
    }
}

/** 全服共享的结构位图缓存：同一 structureId 只扫描一次。 */
export const structureBlockMasks = new StructureBlockMaskCache();
