/**
 * Observatory configuration file.
 *
 * A world can host several BEGame packs at once, and Bedrock only lets a pack
 * register custom commands in its own single namespace (`NamespaceMismatch`),
 * so the bridge command names differ per pack (`ddz:tracelist`,
 * `game:tracelist`, ...). The Observatory therefore cannot assume a fixed
 * namespace; it has to be told which packs to talk to.
 *
 * An earlier design advertised namespaces through a world scoreboard objective
 * so the client could discover them at runtime. That mechanism was never
 * verified to work and has been removed, so the namespace list is explicit
 * configuration instead.
 *
 * The file is optional. `observatory.config.json` is looked up next to the
 * process cwd, then next to the installed package, so a globally installed
 * Observatory works without any file at all.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** One pack the `/connect` bridge should query. */
export interface ConnectTarget {
    /** Command namespace the pack registered, e.g. `ddz`. */
    readonly namespace: string;
    /** Human label shown in the workbench; defaults to the namespace. */
    readonly packName?: string;
    /** Game identifiers the pack reports; informational only. */
    readonly games?: readonly string[];
}

/** Shape of `observatory.config.json`. Every field is optional. */
export interface ObservatoryConfigFile {
    readonly host?: string;
    readonly port?: number;
    readonly connect?: {
        readonly port?: number;
        /**
         * Packs to query. Either a list of targets or a plain
         * `namespace -> metadata` map, since writing a map is more natural for
         * a handful of packs.
         */
        readonly targets?: readonly ConnectTarget[] | Record<string, Omit<ConnectTarget, "namespace">>;
    };
    readonly net?: {
        readonly port?: number;
        readonly token?: string;
    };
    readonly ingest?: {
        readonly dir?: string;
        readonly token?: string;
    };
    readonly archive?: {
        readonly dir?: string;
    };
}

export interface LoadedConfig {
    readonly config: ObservatoryConfigFile;
    /** Absolute path of the file that was read, when one was found. */
    readonly path?: string;
    /** Non-fatal problems (unreadable file, bad JSON) worth warning about. */
    readonly warnings: readonly string[];
}

const FILE_NAME = "observatory.config.json";

function coercePort(value: unknown, label: string, warnings: string[]): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
        warnings.push(`${label} 不是有效端口，已忽略：${JSON.stringify(value)}`);
        return undefined;
    }
    return value;
}

function coerceString(value: unknown, label: string, warnings: string[]): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
        warnings.push(`${label} 不是有效字符串，已忽略：${JSON.stringify(value)}`);
        return undefined;
    }
    return value;
}

/**
 * Normalizes `targets` from either accepted shape and drops entries whose
 * namespace cannot be a Bedrock command namespace.
 */
export function normalizeTargets(raw: unknown): { targets: ConnectTarget[]; warnings: string[] } {
    const warnings: string[] = [];
    const targets: ConnectTarget[] = [];
    if (raw === undefined) return { targets, warnings };
    // Both a list and a namespace map are accepted, so only non-objects (and
    // null) are rejected here.
    if (raw === null || typeof raw !== "object") {
        return { targets, warnings: ["connect.targets 必须是对象或数组，已忽略"] };
    }

    const entries: [string, unknown][] = Array.isArray(raw)
        ? raw.map((item) => [
              typeof (item as ConnectTarget | undefined)?.namespace === "string"
                  ? (item as ConnectTarget).namespace
                  : "",
              item,
          ])
        : Object.entries(raw as Record<string, unknown>);

    const seen = new Set<string>();
    for (const [key, value] of entries) {
        const record = (value ?? {}) as Record<string, unknown>;
        const namespace = typeof record.namespace === "string" ? record.namespace : key;
        const trimmed = namespace.trim();
        // Bedrock namespaces are lowercase alphanumerics/underscore only; a bad
        // value would silently produce commands the game cannot parse.
        if (!/^[a-z0-9_]+$/.test(trimmed)) {
            warnings.push(`跳过无效 namespace：${JSON.stringify(namespace)}`);
            continue;
        }
        if (seen.has(trimmed)) {
            warnings.push(`跳过重复 namespace：${trimmed}`);
            continue;
        }
        seen.add(trimmed);
        const games = Array.isArray(record.games)
            ? record.games.filter((game): game is string => typeof game === "string")
            : undefined;
        targets.push({
            namespace: trimmed,
            packName: typeof record.packName === "string" ? record.packName : undefined,
            games,
        });
    }
    return { targets, warnings };
}

function parseConfig(text: string, warnings: string[]): ObservatoryConfigFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        warnings.push(`${FILE_NAME} 不是合法 JSON，已忽略：${(error as Error).message}`);
        return {};
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push(`${FILE_NAME} 顶层必须是对象，已忽略`);
        return {};
    }
    const source = parsed as Record<string, unknown>;
    const connect = source.connect as Record<string, unknown> | undefined;
    const net = source.net as Record<string, unknown> | undefined;
    const ingest = source.ingest as Record<string, unknown> | undefined;
    const archive = source.archive as Record<string, unknown> | undefined;
    const asObject = (value: unknown): Record<string, unknown> | undefined =>
        value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;

    const config: ObservatoryConfigFile = {
        host: coerceString(source.host, "host", warnings),
        port: coercePort(source.port, "port", warnings),
    };
    if (asObject(connect)) {
        const normalized = normalizeTargets(connect.targets);
        warnings.push(...normalized.warnings);
        config.connect = {
            port: coercePort(connect.port, "connect.port", warnings),
            targets: normalized.targets,
        };
    } else if (connect !== undefined) {
        warnings.push("connect 必须是对象，已忽略");
    }
    if (asObject(net)) {
        config.net = {
            port: coercePort(net.port, "net.port", warnings),
            token: coerceString(net.token, "net.token", warnings),
        };
    } else if (net !== undefined) {
        warnings.push("net 必须是对象，已忽略");
    }
    if (asObject(ingest)) {
        config.ingest = {
            dir: coerceString(ingest.dir, "ingest.dir", warnings),
            token: coerceString(ingest.token, "ingest.token", warnings),
        };
    } else if (ingest !== undefined) {
        warnings.push("ingest 必须是对象，已忽略");
    }
    if (asObject(archive)) {
        config.archive = {
            dir: coerceString(archive.dir, "archive.dir", warnings),
        };
    } else if (archive !== undefined) {
        warnings.push("archive 必须是对象，已忽略");
    }
    return config;
}

/**
 * Reads the first readable config file among `candidates`. Missing files are
 * normal (the file is optional), so they produce no warning; an unreadable or
 * malformed file is reported instead of aborting the process.
 */
export function loadConfig(candidates: readonly string[]): LoadedConfig {
    const warnings: string[] = [];
    for (const candidate of candidates) {
        const path = isAbsolute(candidate) ? candidate : resolve(candidate);
        let text: string;
        try {
            text = readFileSync(path, "utf8");
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "EISDIR") continue;
            warnings.push(`无法读取 ${path}：${(error as Error).message}`);
            continue;
        }
        const config = parseConfig(text, warnings);
        return { config, path, warnings };
    }
    return { config: {}, warnings };
}

/** The config file locations tried, in order, for a given package root. */
export function configCandidates(packageRoot: string, cwd: string): string[] {
    return [resolve(cwd, FILE_NAME), resolve(packageRoot, FILE_NAME)];
}

export { FILE_NAME as CONFIG_FILE_NAME };
