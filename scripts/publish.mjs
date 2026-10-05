import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

/**
 * Derived from the workspace manifests rather than hand-listed, for the same
 * reason as `scripts/pack.mjs`: a hand-maintained release list silently omits
 * the package added later, and the release still exits 0.
 */
const packagesDir = resolve(root, "packages");
const packages = readdirSync(packagesDir)
    .map((entry) => ({
        dir: resolve(packagesDir, entry),
        manifest: resolve(packagesDir, entry, "package.json"),
    }))
    .filter((entry) => existsSync(entry.manifest))
    .map((entry) => ({
        ...entry,
        pkg: JSON.parse(readFileSync(entry.manifest, "utf8")),
    }))
    .filter((entry) => entry.pkg.private !== true);

if (packages.length === 0) {
    console.error("No publishable packages found under packages/");
    process.exit(1);
}

/**
 * Sibling dependencies are pinned to exact versions, so a dependent package must
 * reach the registry *after* the package it names. Publishing in dependency
 * order keeps the registry consistent at every intermediate step, instead of
 * leaving a window where `@begame/test` resolves to a missing `@begame/core`.
 *
 * Optional peers are edges too: `@begame/trace` may be installed alone, but any
 * consumer that pairs it with `@begame/core` should find a matching version.
 */
function publishOrder(entries) {
    const byName = new Map(entries.map((entry) => [entry.pkg.name, entry]));
    const ordered = [];
    const state = new Map();

    function visit(entry, chain) {
        const seen = state.get(entry.pkg.name);
        if (seen === "done") return;
        if (seen === "visiting") {
            throw new Error(
                `Workspace dependency cycle: ${[...chain, entry.pkg.name].join(" -> ")}`
            );
        }

        state.set(entry.pkg.name, "visiting");
        const siblings = Object.keys({
            ...entry.pkg.dependencies,
            ...entry.pkg.peerDependencies,
        }).filter((name) => byName.has(name));

        for (const name of siblings) {
            visit(byName.get(name), [...chain, entry.pkg.name]);
        }

        state.set(entry.pkg.name, "done");
        ordered.push(entry.pkg.name);
    }

    for (const entry of [...entries].sort((a, b) =>
        a.pkg.name.localeCompare(b.pkg.name)
    )) {
        visit(entry, []);
    }

    return ordered;
}

/**
 * `npm publish` ships whatever `files` matches, so a missing or stale `dist`
 * publishes a broken package that only fails on the consumer's machine. Check
 * every entry point a manifest advertises — `main`, `types`, `bin`, and the
 * non-wildcard `exports` targets — before anything reaches the registry.
 */
function entryPoints(pkg) {
    const found = new Set();
    const add = (value) => {
        if (typeof value === "string" && !value.includes("*")) found.add(value);
    };

    add(pkg.main);
    add(pkg.types);
    add(pkg.module);
    for (const target of Object.values(pkg.bin ?? {})) add(target);
    for (const entry of Object.values(pkg.exports ?? {})) {
        if (typeof entry === "string") {
            add(entry);
            continue;
        }
        for (const value of Object.values(entry ?? {})) add(value);
    }

    return [...found];
}

const missingBuilds = [];
for (const entry of packages) {
    for (const relative of entryPoints(entry.pkg)) {
        if (!existsSync(resolve(entry.dir, relative))) {
            missingBuilds.push(`${entry.pkg.name}: ${relative}`);
        }
    }
}

if (missingBuilds.length > 0) {
    console.error("Missing build output:");
    for (const missing of missingBuilds) {
        console.error(`  ${missing}`);
    }
    console.error("Run `npm run build` first.");
    process.exit(1);
}

const order = publishOrder(packages);
const forwarded = process.argv.slice(2);

console.log(`Publishing ${order.length} BEGame packages: ${order.join(", ")}`);
if (forwarded.length > 0) {
    console.log(`Forwarding to npm publish: ${forwarded.join(" ")}`);
}

for (const name of order) {
    const args = [
        "publish",
        "--workspace",
        name,
        "--access",
        "public",
        ...forwarded,
    ];
    console.log(`\n> npm ${args.join(" ")}`);

    const npmExecPath = process.env.npm_execpath;
    const result = npmExecPath
        ? spawnSync(process.execPath, [npmExecPath, ...args], {
              cwd: root,
              stdio: "inherit",
          })
        : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
              cwd: root,
              stdio: "inherit",
          });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        console.error(`\nFailed while publishing ${name}.`);
        process.exit(result.status ?? 1);
    }
}

console.log(`\nPublished ${order.length} BEGame packages.`);
