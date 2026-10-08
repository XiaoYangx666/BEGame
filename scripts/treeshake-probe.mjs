/**
 * Tree-shaking probe.
 *
 * Bundles a tiny consumer that imports exactly one symbol from a BEGame package
 * and reports which modules the bundler actually pulled in. This is a property
 * of the built dist plus the package manifests, so it cannot be observed from
 * source alone.
 *
 * Detection is by module id, never by scanning the output text: identifiers like
 * `Timer` or `DisconnectTimeout` also occur as members of the trace
 * BuiltinTraceEventType enum, so substring matching reports false positives.
 *
 * Usage: node scripts/treeshake-probe.mjs [--json]
 */
import { rolldown } from "rolldown";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const COMPONENT_MODULES = [
    "gameComponent/common/lazyLoader",
    "gameComponent/common/timer/timer",
    "gameComponent/common/stopWatch/stopWatch",
    "gameComponent/common/disconnectTimeout",
    "gameComponent/player/blockInteractionBlocker",
    "gameComponent/player/entityInteractionBlocker",
    "gameComponent/player/respawn",
    "gameComponent/player/spawnProtector",
    "gameComponent/player/healthIndicator",
    "gameComponent/player/regionMonitor",
    "gameComponent/region/regionProtecter",
    "gameComponent/region/regionTeamChooser",
    "gameComponent/region/regionTeamCleaner",
    "gameComponent/view/infoScoreboard",
    "gameComponent/view/teamScoreboard",
];

const RUNTIME_TRACE_MODULES = [
    "trace/dist/runtime/manager",
    "trace/dist/runtime/historyStore",
    "trace/dist/runtime/session",
    "trace/dist/wire/binary",
    "trace/dist/wire/container",
    "trace/dist/runtime/consoleExporter",
];

/** @param {string[]} modules */
function matches(modules, needles = []) {
    return needles.filter((needle) =>
        modules.some((id) => id.includes(needle))
    );
}

const CASES = [
    {
        name: "gameState-only",
        entry: `import { GameState } from "@begame/core";\nexport const probe = GameState;\n`,
        import: "@begame/core",
        forbid: [...COMPONENT_MODULES, ...RUNTIME_TRACE_MODULES],
        // Importing anything from the package entry runs the entry's module-level
        // side effects. These register worldLoad gating and build the global
        // manager singleton. Losing them silently breaks world access ordering,
        // so this case fails loudly if sideEffects is ever declared too broadly.
        //
        // `system/worldReady` is deliberately NOT required here: it is only
        // needed by the server and trace entries, which import it themselves.
        require: ["core/dist/constants", "core/dist/main"],
    },
    {
        name: "gameState-subpath",
        entry: `import { GameState } from "@begame/core/gameState";\nexport const probe = GameState;\n`,
        import: "@begame/core/gameState",
        require: ["core/dist/gameState/gameState"],
        forbid: [...COMPONENT_MODULES, ...RUNTIME_TRACE_MODULES],
    },
    {
        name: "timer-component-only",
        require: ["core/dist/gameComponent/common/timer/timer"],
        entry: `import { Timer } from "@begame/core";\nexport const probe = Timer;\n`,
        import: "@begame/core",
        forbid: [
            ...COMPONENT_MODULES.filter((m) => !m.includes("timer/timer")),
            ...RUNTIME_TRACE_MODULES,
        ],
    },
    {
        // The Minecraft binding is a separate entry, injected at the consumer's
        // composition root. Importing it must bring the implementation, and must
        // still leave the game/component layer behind.
        name: "trace-minecraft-binding",
        entry: `import { createTraceRuntime } from "@begame/trace/minecraft";\nexport const probe = createTraceRuntime;\n`,
        import: "@begame/trace/minecraft",
        forbid: [
            ...COMPONENT_MODULES,
            "core/dist/gameState/gameState",
            "core/dist/gameEngine",
            "core/dist/gamePlayer/playerManager",
        ],
        require: [
            "trace/dist/minecraft",
            "trace/dist/runtime/manager",
            "trace/dist/runtime/historyStore",
            "trace/dist/runtime/session",
            "trace-spec/dist/types",
        ],
    },
    {
        // The platform-independent half: decoding a log must not drag Minecraft
        // or the game runtime in, which is what lets the observatory run in
        // plain Node.
        name: "trace-codec-root",
        require: ["trace/dist/wire/decoder", "trace/dist/tools/logParser"],
        entry: `import { decodeTraceLog, decodeBegTrace } from "@begame/trace";\nexport const probe = [decodeTraceLog, decodeBegTrace];\n`,
        import: "@begame/trace",
        forbid: [
            ...COMPONENT_MODULES,
            "trace/dist/minecraft",
            "trace/dist/manager",
            "trace-spec/dist/management",
        ],
    },
    {
        // @begame/core must not drag the codec or the runtime in for anyone.
        name: "core-has-no-trace-dependency",
        entry: `import { Game, initBEGame } from "@begame/core";\nexport const probe = [Game, initBEGame];\n`,
        import: "@begame/core",
        forbid: ["trace/dist/"],
        require: ["trace-spec/dist/types"],
    },
];

const EXTERNAL = ["@minecraft/server", "@minecraft/server-ui"];

function toRepoPath(id) {
    const normalized = id.split("\\").join("/").replace(/^\0+/, "");
    const index = normalized.lastIndexOf("/node_modules/");
    if (index !== -1) return normalized.slice(index + "/node_modules/".length);
    if (path.isAbsolute(normalized)) {
        return path.relative(root, normalized).split("\\").join("/");
    }
    return normalized;
}

async function bundleCase(dir, testCase) {
    const entryFile = path.join(dir, `${testCase.name}.js`);
    await writeFile(entryFile, testCase.entry, "utf8");

    const bundle = await rolldown({
        input: entryFile,
        external: EXTERNAL,
        resolve: { modules: [path.join(root, "node_modules")] },
        onLog(level, log, defaultHandler) {
            if (log.code === "UNRESOLVED_IMPORT") {
                throw new Error(`Package resolution failed: ${log.message}`);
            }
            defaultHandler(level, log);
        },
    });
    try {
        const { output } = await bundle.generate({ format: "esm", minify: false });
        const chunks = output.filter((item) => item.type === "chunk");
        const unexpectedImports = chunks.flatMap((chunk) => chunk.imports)
            .filter((specifier) => !EXTERNAL.includes(specifier));
        if (unexpectedImports.length > 0) {
            throw new Error(`Unexpected external imports: ${unexpectedImports.join(", ")}`);
        }
        const code = chunks.map((item) => item.code).join("\n");

        const ids = new Set();
        for (const chunk of chunks) {
            for (const id of Object.keys(chunk.modules ?? {})) {
                ids.add(toRepoPath(id));
            }
        }
        const modules = [...ids].sort();
        return {
            bytes: Buffer.byteLength(code),
            moduleCount: modules.length,
            kept: matches(modules, testCase.forbid),
            missing: (testCase.require ?? []).filter(
                (needle) => !modules.some((id) => id.includes(needle))
            ),
            modules,
        };
    } finally {
        await bundle.close();
    }
}

// Check exports and build output before a missing package can become external.
for (const testCase of CASES) {
    const entry = fileURLToPath(import.meta.resolve(testCase.import));
    try {
        await access(entry);
    } catch {
        throw new Error(`Missing build output for ${testCase.import}: ${entry}. Run npm run build first, then run this probe after the build finishes.`);
    }
}

// Keep consumers under the repository so platform temp directories cannot
// introduce a different ancestor package tree during resolution.
const cacheDir = path.join(root, "cache");
await mkdir(cacheDir, { recursive: true });
const dir = await mkdtemp(path.join(cacheDir, "begame-treeshake-"));
const results = [];
try {
    for (const testCase of CASES) {
        const result = await bundleCase(dir, testCase);
        results.push({
            case: testCase.name,
            import: testCase.import,
            bytes: result.bytes,
            moduleCount: result.moduleCount,
            kept: result.kept,
            missing: result.missing,
            modules: result.modules,
        });
    }
} finally {
    await rm(dir, { recursive: true, force: true });
}

const verbose = process.argv.includes("--verbose");

if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
} else {
    for (const result of results) {
        console.log(
            `\n${result.case}  (import "${result.import}")  ${result.bytes.toLocaleString("en-US")} B, ${result.moduleCount} modules`
        );
        console.log(
            result.kept.length === 0
                ? "  unused modules kept: none"
                : `  UNUSED MODULES KEPT (${result.kept.length}):\n${result.kept.map((m) => `    - ${m}`).join("\n")}`
        );
        if (result.missing.length > 0) {
            console.log(
                `  REQUIRED MODULES MISSING (${result.missing.length}):\n${result.missing.map((m) => `    - ${m}`).join("\n")}`
            );
        }
        if (verbose) {
            console.log(`  all modules:\n${result.modules.map((m) => `    ${m}`).join("\n")}`);
        }
    }
}

const dirty = results.filter(
    (result) => result.kept.length > 0 || result.missing.length > 0
);
console.log(
    `\n${dirty.length === 0 ? "PASS" : "FAIL"}: ${results.length - dirty.length}/${results.length} cases clean`
);
process.exit(dirty.length === 0 ? 0 : 1);
