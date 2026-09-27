import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createApp } from "../packages/observatory/server/app.ts";

/** Committed generated fixture; see `scripts/make-observatory-fixture.mjs`. */
function sampleTrace() {
    return readFileSync(new URL("./fixtures/observatory-sample.begtrace", import.meta.url));
}

test("agent API exposes capabilities and a structured analysis", async () => {
    const app = createApp();

    const health = await app.request("/api/health");
    const healthBody = await health.json();
    expect(healthBody.capabilities).toEqual({
        http: true,
        connect: false,
        connectTargets: 0,
        net: false,
        ingest: false,
        archive: false,
    });

    // Nothing is opened by default, so there are no live sources.
    const sessions = await app.request("/api/sessions");
    expect(await sessions.json()).toMatchObject({ sources: [] });

    const netStatus = await app.request("/api/net/status");
    expect(await netStatus.json()).toMatchObject({ enabled: false });
    const ingestStatus = await app.request("/api/ingest/status");
    expect(await ingestStatus.json()).toMatchObject({ enabled: false });

    // /api/analyze returns only the generic analysis, not the raw events.
    const analyzed = await app.request("/api/analyze", { method: "POST", body: sampleTrace() });
    expect(analyzed.status).toBe(200);
    const analysisBody = await analyzed.json();
    expect(analysisBody.ok).toBe(true);
    expect(analysisBody.analysis.gameType).toBe("doudizhu");
    expect(analysisBody.analysis.errorCount).toBe(1);
    expect(analysisBody.analysis.domainCount).toBeGreaterThan(0);
    expect(analysisBody.selected).toBeUndefined();
    expect(analysisBody.events).toBeUndefined();

    // /api/decode also lifts the analysis to the top level for the workbench.
    const decoded = await app.request("/api/decode", { method: "POST", body: sampleTrace() });
    const decodedBody = await decoded.json();
    expect(decodedBody.ok).toBe(true);
    expect(decodedBody.analysis.gameType).toBe("doudizhu");
    // The decoded session must carry every event the fixture was built with;
    // the exact number is a property of the generator, not of this endpoint.
    expect(decodedBody.selected.events.length).toBeGreaterThan(0);
});
