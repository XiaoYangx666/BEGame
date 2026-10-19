# Release notes draft — BEGame 0.1.1

This synchronized release refreshes npm metadata and includes the Trace and Observatory changes merged after 0.1.0. All five package names remain unchanged. Published 0.1.0 versions are immutable and retain their existing npm metadata.

## Trace and bridge updates

- `TraceHistoryStore.list()` now caches its sorted summaries and rebuilds the snapshot only after a store write or deletion.
- `TraceHistoryStore.listSince()` adds revisioned incremental listings. The ServerNet `list` request accepts an optional `since` revision and can return changed summaries, deleted session IDs, a full-snapshot fallback, or a small unchanged acknowledgement. A bounded 256-entry deletion tombstone window forces a full snapshot when a client is too far behind.
- Observatory merges listing deltas, combines list/store status, and falls back to full replacements for legacy packs without revision fields. Reconnected packs start with a fresh listing cache.
- Added regression coverage for long-session chunk archiving and retention, bridge reconnect/backoff, initial-config snapshot depth, delta deletion/fallback, and concurrent polls.

## Observatory updates

- Added background daemon operation and process management.
- Added Tabletop participant and seat event support in Trace analysis and views.

## Known limitation

`snapshotTraceValue()` still replaces nested containers at depth 5 or greater with `"[Array]"` / `"[Object]"`. The 0.1.1 tests characterize this behavior; this release does not fix deep `initialConfig` snapshot truncation.

## Packages and links

All five packages are versioned `0.1.1` together. Exact internal dependencies and peers use the same version where applicable; no external dependency declarations were added. Published links use the canonical repository:

- Repository: <https://github.com/XiaoYangx666/BEGame>
- Homepage: <https://github.com/XiaoYangx666/BEGame#readme>
- Issues: <https://github.com/XiaoYangx666/BEGame/issues>

| Package | Install |
| --- | --- |
| `@begame/core` | `npm install @begame/core@0.1.1` |
| `@begame/trace` | `npm install @begame/trace@0.1.1` |
| `@begame/observatory` | `npm install @begame/observatory@0.1.1` |
| `@begame/trace-spec` | `npm install @begame/trace-spec@0.1.1` |
| `@begame/test` | `npm install @begame/test@0.1.1` |

Core still declares `@minecraft/server >=2.10.0` and `@minecraft/server-ui >=2.2.0` peers. Trace's optional peers remain optional.

## Validation

- `npm ci --ignore-scripts`: PASS (Node 26.9.0, npm 12.2.0).
- `npm run build`: PASS; all five package builds completed.
- Trace/Observatory targeted tests: PASS, 51 tests across 6 files.
- `npx vitest run --exclude tests/observatory-daemon.test.mjs`: PASS, 232 tests across 33 files. Full `npm test` on Windows: 239/242 passed; the three failures are in `observatory-daemon.test.mjs`, which assumes POSIX path resolution and hits detached-process cleanup `EPERM`. Run the full suite in Ubuntu CI before release.
- `npm run test:treeshake`: PASS, 6/6 probes.
- `npm run release:check`: PASS, all five 0.1.1 tarballs validated in npm dry-run; no upload.
- `npm run pack`: PASS, five local tarballs created.
- Minecraft client and BDS target-runtime checks: NOT RUN.
