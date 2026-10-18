import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
    eventFamily,
    eventSeverity,
    eventSubtype,
    isInternalEvent,
    summarizeEvent,
} from "../packages/observatory/src/analysis.mjs";
import { decodeTracePayload } from "../packages/observatory/src/decode.mjs";

/**
 * A committed, generated fixture (see `scripts/make-observatory-fixture.mjs`).
 *
 * This used to read `traces/a.txt`, which `.gitignore` excludes, so the test
 * depended on a developer's local recording and failed on a fresh clone. The
 * fixture is generated through the real `TraceManager`, so it is a valid
 * container with a known event mix.
 */
function sampleTrace() {
    return readFileSync(new URL("./fixtures/observatory-sample.begtrace", import.meta.url));
}

test("analysis classifies builtins, native sources and first-party Tabletop events", () => {
    expect(eventFamily("game.created")).toBe("game");
    expect(eventFamily("state.push")).toBe("state");
    expect(eventFamily("component.attached")).toBe("component");
    expect(eventFamily("participation.joined")).toBe("participation");
    expect(eventFamily("player.connect")).toBe("connection");
    expect(eventFamily("disconnect_timeout.expired")).toBe("timeout");
    expect(eventFamily("runner.cancelled")).toBe("runtime");
    expect(eventFamily("debug.message")).toBe("debug");
    expect(eventFamily("anything.custom")).toBe("domain");
    expect(eventFamily("plain")).toBe("domain");
    expect(eventFamily("tabletop.member.changed")).toBe("participation");
    expect(eventFamily("tabletop.seat.changed")).toBe("participation");
    expect(eventFamily("tabletop.presence.changed")).toBe("connection");
    expect(eventFamily("tabletop.stage.changed")).toBe("domain");
    expect(eventFamily("any.other", "participation")).toBe("participation");
    expect(eventFamily("any.other", "connection")).toBe("connection");
    // An unrelated game's similarly named event must not be hijacked.
    expect(eventFamily("other.seat.changed", "game")).toBe("domain");
});

test("severity and internal classification are namespace-based", () => {
    expect(eventSeverity("component.error")).toBe("error");
    expect(eventSeverity("x.transition.rejected")).toBe("error");
    expect(eventSeverity("state.transition")).toBe("accent");
    expect(eventSeverity("state.enter")).toBe("muted");
    expect(eventSeverity("game.started")).toBe("normal");

    expect(isInternalEvent("runner.cancelled")).toBe(true);
    expect(isInternalEvent("component.attach_started")).toBe(true);
    expect(isInternalEvent("component.attach_failed")).toBe(false);
    expect(isInternalEvent("doudizhu.event")).toBe(false);
});

test("envelope subtype and summary are read generically", () => {
    const event = {
        sequence: 1,
        tick: 0,
        typeId: 0,
        type: "anything.event",
        source: { kind: "game" },
        payload: { type: "round.started", seat: 2, ok: true, nested: { a: 1 } },
    };
    expect(eventSubtype(event)).toBe("round.started");
    // Only scalar fields are summarized; `type` is the subtype, not a field.
    expect(summarizeEvent(event)).toBe("seat=2 ok=true");
    expect(eventSubtype({ ...event, payload: {} })).toBeUndefined();
});

test("real trace analysis is structured without any game-specific rules", () => {
    const result = decodeTracePayload(sampleTrace());
    expect(result.ok).toBe(true);
    const analysis = result.analysis;
    expect(analysis).toBeTruthy();
    expect(analysis.gameType).toBe("doudizhu");

    // Framework internals are classified as runtime noise, not domain events.
    expect(analysis.families.runtime).toBeGreaterThan(0);
    expect(analysis.internalCount).toBeGreaterThan(0);
    expect(analysis.internalByType["runner.cancelled"]).toBeGreaterThan(0);

    // Business events are classified as domain. Custom (schema-typed) events
    // are reported under `type`, not `subtype`: `subtype` is only populated for
    // events carrying a payload envelope.
    expect(analysis.families.domain).toBeGreaterThan(0);
    const played = analysis.domainTypes.find((entry) => entry.type === "cards.played");
    expect(played?.count).toBeGreaterThan(0);

    // Exactly one diagnostic, and it is the rejected transition.
    expect(analysis.errorCount).toBe(1);
    expect(analysis.diagnostics[0].type).toBe("doudizhu.transition.rejected");

    // Participants come from the generic context builder. Only assertions the
    // fixture actually guarantees belong here; counts that merely describe the
    // sample would have to be updated on every regeneration.
    expect(analysis.players).toHaveLength(4);
});
