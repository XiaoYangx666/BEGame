import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { encodeBegTrace } from "../packages/trace/dist/index.js";
import { createApp } from "../packages/observatory/server/app.ts";

const observatoryManifest = JSON.parse(
    readFileSync(new URL("../packages/observatory/package.json", import.meta.url), "utf8")
);

function makeTraceBytes(sessionId) {
    return encodeBegTrace(
        {
            sessionId,
            formatVersion: 1,
            gameType: "server-test",
            gameKey: "server-test:0",
            gameInstanceId: sessionId,
            startTick: 0,
            startWallTime: 0,
        },
        [],
        {
            sessionId,
            status: "completed",
            endTick: 10,
            endWallTime: 100,
            endReason: "test",
            eventCount: 0,
            chunkCount: 0,
        }
    );
}

test("observatory server exposes health, decode and static assets", async () => {
    const app = createApp();

    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.ok).toBe(true);
    // Guards against the version drifting from the manifest it is published with.
    expect(healthBody.version).toBe(observatoryManifest.version);

    const decoded = await app.request("/api/decode", {
        method: "POST",
        body: makeTraceBytes("server-test"),
    });
    expect(decoded.status).toBe(200);
    const payload = await decoded.json();
    expect(payload.ok).toBe(true);
    expect(payload.selected.sessionId).toBe("server-test");
    expect(payload.selected.context.nodes.length).toBeGreaterThan(0);

    const empty = await app.request("/api/decode", {
        method: "POST",
        body: new Uint8Array(),
    });
    expect(empty.status).toBe(400);

    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="app"');

    const missing = await app.request("/definitely-missing");
    expect(missing.status).toBe(404);
});
