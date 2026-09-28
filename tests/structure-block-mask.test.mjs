import { expect, test } from "vitest";
import {
    StructureBlockMask,
    StructureBlockMaskCache,
} from "../packages/core/dist/main.js";

function fakeStructure(id, size, blocks, onRead) {
    return {
        id,
        size,
        getBlockPermutation({ x, y, z }) {
            onRead?.();
            const typeId = blocks[`${x},${y},${z}`];
            return typeId ? { type: { id: typeId } } : undefined;
        },
    };
}

function scan(cache, structure, batchSize = 2048) {
    let ready;
    const job = cache.scan(structure, (mask) => {
        ready = mask;
    }, batchSize);
    while (!job.next().done) {}
    if (!ready) throw new Error("scan did not publish a complete mask");
    return ready;
}

test("结构位图：只标记原始非空气方块，正确处理末端索引及负坐标原点", () => {
    const cache = new StructureBlockMaskCache();
    const mask = scan(
        cache,
        fakeStructure("test:mask", { x: 3, y: 2, z: 2 }, {
            "0,0,0": "minecraft:stone",
            "1,0,0": "minecraft:air",
            "2,1,1": "minecraft:glass",
            "0,0,1": "minecraft:structure_void",
        }),
        3
    );

    expect(mask.byteLength).toBe(2); // 12 个方块 -> 12 位
    expect(mask.solidCount).toBe(2);
    expect(mask.hasRelativeBlock({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(mask.hasRelativeBlock({ x: 2, y: 1, z: 1 })).toBe(true);
    expect(mask.hasRelativeBlock({ x: 1, y: 0, z: 0 })).toBe(false);
    expect(mask.hasRelativeBlock({ x: 0, y: 0, z: 1 })).toBe(false);
    expect(mask.hasRelativeBlock({ x: 3, y: 0, z: 0 })).toBe(false);
    expect(mask.hasRelativeBlock({ x: -1, y: 0, z: 0 })).toBe(false);
    expect(mask.hasRelativeBlock({ x: 0.5, y: 0, z: 0 })).toBe(false);
    expect(
        mask.hasWorldBlock({ x: -8, y: 12, z: 9 }, { x: -10, y: 11, z: 8 })
    ).toBe(true);
});

test("结构位图：扫描未完成前不发布缓存；同模板后续房间不重复扫描", () => {
    const cache = new StructureBlockMaskCache();
    let reads = 0;
    let published;
    const structure = fakeStructure(
        "test:cache", { x: 4, y: 2, z: 2 },
        { "3,1,1": "minecraft:stone" },
        () => { reads++; }
    );
    const job = cache.scan(structure, (mask) => { published = mask; }, 2);

    expect(job.next().done).toBe(false);
    expect(cache.get(structure.id)).toBeUndefined();
    expect(published).toBeUndefined();

    // 模拟 RunnerManager.runJob 在 State 卸载时被取消：不继续迭代。
    job.return(undefined);
    expect(cache.get(structure.id)).toBeUndefined();
    expect(published).toBeUndefined();

    const first = scan(cache, structure, 2);
    expect(reads).toBeGreaterThan(2);
    const readCount = reads;
    const second = scan(cache, structure, 2);
    expect(second).toBe(first);
    expect(reads).toBe(readCount);

    cache.invalidate(structure.id);
    expect(cache.get(structure.id)).toBeUndefined();
});

test("结构位图：同一模板复用，不依赖临时方块记录", () => {
    const cache = new StructureBlockMaskCache();
    const mask = scan(cache, fakeStructure("test:shared", { x: 3, y: 1, z: 1 }, {
        "0,0,0": "minecraft:stone",
    }));
    const first = { x: -10, y: 5, z: 10 };
    const second = { x: 20, y: 5, z: 10 };

    expect(mask.hasWorldBlock({ x: -10, y: 5, z: 10 }, first)).toBe(true);
    expect(mask.hasWorldBlock({ x: 20, y: 5, z: 10 }, second)).toBe(true);
    expect(mask.hasWorldBlock({ x: -9, y: 5, z: 10 }, first)).toBe(false);
    expect(mask.hasWorldBlock({ x: 21, y: 5, z: 10 }, second)).toBe(false);
    expect(cache.get("test:shared")).toBe(mask);
});

test("结构位图：异常扫描不发布不完整数据，非法配置提前拒绝", () => {
    const cache = new StructureBlockMaskCache();
    const broken = fakeStructure("test:broken", { x: 2, y: 1, z: 1 }, {});
    const failure = {
        ...broken,
        getBlockPermutation(position) {
            if (position.x === 1) throw new Error("invalid structure");
            return broken.getBlockPermutation(position);
        },
    };
    expect(() => scan(cache, failure)).toThrow("invalid structure");
    expect(cache.get(failure.id)).toBeUndefined();
    expect(() => scan(cache, broken, 0)).toThrow("batchSize");

    const mask = scan(cache, broken);
    expect(mask.hasRelativeBlock({ x: 0.5, y: 0, z: 0 })).toBe(false);
    expect(() => new StructureBlockMask({ x: 0, y: 1, z: 1 }, new Uint8Array(0), 0))
        .toThrow("无效的结构尺寸");
});
