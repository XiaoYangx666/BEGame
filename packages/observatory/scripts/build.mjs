/**
 * Standalone build for `@begame/observatory`.
 *
 * The package used to be built only by the monorepo's root `rolldown.config.ts`,
 * which addressed every workspace by a repo-relative path (`packages/...`). That
 * made the Observatory impossible to build or run outside the BEGame checkout,
 * so the build lives here and is self-contained: it resolves everything from
 * this package's own directory.
 *
 * Two bundles are produced:
 *
 * - `dist/`    — the Node server, with `@begame/trace` and the Node/npm
 *                dependencies kept external so they resolve from `node_modules`.
 * - `public/build/` — the browser workbench UI, fully bundled.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, build } from "rolldown";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(packageRoot, "src");
const serverRoot = resolve(packageRoot, "server");

/** Everything the published package expects to find in its own node_modules. */
const external = [
    /^@begame\/trace(\/|$)/,
    /^@hono\/node-server(\/|$)/,
    /^hono(\/|$)/,
    /^node:/,
];

/**
 * A missing dependency must fail the build.
 *
 * By default rolldown only warns (`UNRESOLVED_IMPORT`) and emits the bundle with
 * the import left dangling. That is how the browser UI once shipped without
 * React: the build reported success while `public/build/app.js` referenced a
 * package that was not installed. Anything not resolved here and not declared
 * external would break at runtime, so it fails the build instead.
 */
function failOnUnresolvedImport(level, log, defaultHandler) {
    if (log.code === "UNRESOLVED_IMPORT") {
        throw new Error(`Unresolved import: ${log.message}`);
    }
    defaultHandler(level, log);
}

const serverConfig = defineConfig({
    input: {
        server: resolve(serverRoot, "index.ts"),
        cli: resolve(serverRoot, "cli.ts"),
    },
    external,
    onLog: failOnUnresolvedImport,
    platform: "node",
    output: {
        dir: resolve(packageRoot, "dist"),
        format: "esm",
        entryFileNames: "[name].js",
    },
});

const appConfig = defineConfig({
    input: { app: resolve(srcRoot, "main.tsx") },
    platform: "browser",
    onLog: failOnUnresolvedImport,
    // `define` is a transform-level option in rolldown (unlike Vite/Rollup,
    // where it sits at the top level). React reads `process.env.NODE_ENV`, so
    // it must be replaced for the browser bundle.
    transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") } },
    output: {
        dir: resolve(packageRoot, "public", "build"),
        format: "esm",
        entryFileNames: "[name].js",
        minify: true,
    },
});

// `public/build` is regenerated every time; a stale bundle silently served by
// the server is worse than a missing one.
const publicBuild = resolve(packageRoot, "public", "build");
if (existsSync(publicBuild)) rmSync(publicBuild, { recursive: true, force: true });
mkdirSync(publicBuild, { recursive: true });
mkdirSync(resolve(packageRoot, "dist"), { recursive: true });

await build(serverConfig);
await build(appConfig);
console.log("Observatory build complete.");
