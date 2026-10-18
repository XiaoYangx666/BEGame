import { expect, test } from "vitest";
import { snapshotTraceValue } from "../packages/trace/dist/index.js";

/**
 * Root-cause characterization for the archived `[...] = ["[Array]", ...]`
 * corruption.
 *
 * `TraceManager.beginSession` snapshots `initialConfig` through
 * `snapshotTraceValue`, whose container budget is intentionally shallow: a
 * nested array/object that sits at depth >= 5 is replaced by a placeholder
 * string, while primitive leaves (number/string/boolean) survive at any depth.
 *
 * The Doudizhu Addon used to pass its complete persisted snapshot as
 * `initialConfig`. With the real structure
 * `initialConfig.snapshot.match.currentRound`, `hands` (an array of arrays) sits
 * at depth 4 and its elements degrade; `history[0]` (an object) degrades. This
 * test pins that exact behavior so the corruption cannot be misdiagnosed as a
 * Minecraft Dynamic Property or a console-formatting problem.
 */
test("snapshotTraceValue degrades deep containers to [Array]/[Object] at depth 5", () => {
    const hands = [
        [1, 2, 3],
        [4, 5],
        [6, 7, 8],
    ];
    const initialConfig = {
        matchId: "m1",
        snapshot: {
            match: {
                currentRound: {
                    hands,
                    bottomCards: [0, 33, 35],
                    history: [{ type: "play", seat: 0, cards: [1, 2] }],
                },
            },
        },
    };

    const encoded = snapshotTraceValue(initialConfig);
    const round = encoded.snapshot.match.currentRound;

    // Primitive leaves survive regardless of depth; only containers degrade.
    expect(round.bottomCards).toEqual([0, 33, 35]);
    // Depth 4 array -> its depth-5 array elements collapse.
    expect(round.hands).toEqual(["[Array]", "[Array]", "[Array]"]);
    // Depth 4 array -> its depth-5 object element collapses.
    expect(round.history[0]).toBe("[Object]");
});

test("snapshotTraceValue keeps a container that starts at depth 4 but drops its nested children", () => {
    const value = { a: { b: { c: { d: { e: { deep: true }, arr: [1, 2] } } } } };
    const encoded = snapshotTraceValue(value);
    // `d` lives at depth 4 and is materialized; its children start at depth 5.
    expect(encoded.a.b.c.d.e).toBe("[Object]");
    expect(encoded.a.b.c.d.arr).toBe("[Array]");
});
