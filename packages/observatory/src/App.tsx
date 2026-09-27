import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DecodeResponse, EventFamily, SessionAnalysis, TraceExportMeta } from "./types";
import { OverviewView } from "./OverviewView";
import { StreamView } from "./StreamView";
import { StructureView } from "./StructureView";
import { ParticipantsView } from "./ParticipantsView";
import { RawView } from "./RawView";
import { fmtBytes, fmtDate } from "./format";

type Tab = "overview" | "stream" | "structure" | "participants" | "raw";
type Health = "connecting" | "ok" | "bad";

interface Capabilities {
    http: boolean;
    connect: boolean;
    /** Configured /connect pack count; 0 means the bridge cannot query anything. */
    connectTargets?: number;
    net: boolean;
    ingest: boolean;
    archive: boolean;
}

interface SourceSession {
    sessionId: string;
    gameType?: string;
    gameKey?: string;
    status?: string;
    eventCount?: number;
    chunkCount?: number;
    startWallTime?: number;
    storedBytes?: number;
    bytes?: number;
    storedAt?: number;
    /** True when this row came from the Observatory's on-disk archive. */
    archived?: boolean;
}

interface NetStoreStatus {
    enabled: boolean;
    acceptingSessions: boolean;
    count: number;
    running: number;
}

interface SourceGroup {
    id: string;
    kind: "connect" | "net" | "ingest";
    connected: boolean;
    pack?: string;
    packName?: string;
    store?: NetStoreStatus;
    sessions: SourceSession[];
    error?: string;
}

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

export function App() {
    const [health, setHealth] = useState<Health>("connecting");
    const [version, setVersion] = useState("");
    const [capabilities, setCapabilities] = useState<Capabilities>({
        http: true,
        connect: false,
        net: false,
        ingest: false,
        archive: false,
    });

    const [sources, setSources] = useState<SourceGroup[]>([]);
    const [collapsedSources, setCollapsedSources] = useState<Set<string>>(() => new Set());
    const [result, setResult] = useState<DecodeResponse | null>(null);
    const [analysis, setAnalysis] = useState<SessionAnalysis | null>(null);
    const [sourceName, setSourceName] = useState("");
    const [isLive, setIsLive] = useState(false);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);

    const [tab, setTab] = useState<Tab>("overview");
    const [importOpen, setImportOpen] = useState(false);
    const [status, setStatus] = useState<{ text: string; kind?: "error" | "busy" }>({ text: "" });
    const [busy, setBusy] = useState(false);

    // Import buffer
    const [input, setInput] = useState("");
    const [bytes, setBytes] = useState<Uint8Array | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    // Stream filters (lifted so Overview can drive them)
    const [families, setFamilies] = useState<Set<EventFamily>>(() => new Set());
    const [showInternal, setShowInternal] = useState(false);
    const [search, setSearch] = useState("");

    const selectedRef = useRef<{ kind: string; pack?: string; sessionId: string } | null>(null);
    const refreshing = useRef(false);

    const selected = result?.ok ? result.selected ?? null : null;

    // ------------------------------------------------------------------
    // Health + source discovery
    // ------------------------------------------------------------------

    useEffect(() => {
        fetch("/api/health")
            .then((response) => response.json())
            .then((data) => {
                setHealth("ok");
                setVersion(String(data.version ?? ""));
                if (data.capabilities) setCapabilities(data.capabilities);
            })
            .catch(() => setHealth("bad"));
    }, []);

    const refreshSources = useCallback(async () => {
        try {
            const response = await fetch("/api/sessions");
            const data = await response.json();
            if (response.ok) {
                setSources(Array.isArray(data.sources) ? data.sources : []);
                if (data.capabilities) setCapabilities(data.capabilities);
            }
        } catch {
            // keep the previous snapshot; the next poll retries
        }
    }, []);

    useEffect(() => {
        void refreshSources();
        const timer = window.setInterval(() => void refreshSources(), 3000);
        return () => window.clearInterval(timer);
    }, [refreshSources]);

    const decodeBytes = useCallback(async (payload: Uint8Array, sessionId?: string) => {
        const url = sessionId
            ? `/api/decode?session=${encodeURIComponent(sessionId)}`
            : "/api/decode";
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: payload as BodyInit,
        });
        return (await response.json()) as DecodeResponse;
    }, []);

    const applyResult = useCallback((data: DecodeResponse, label: string, resetView = true) => {
        setResult(data);
        setAnalysis(data.analysis ?? data.selected?.analysis ?? null);
        setSourceName(label);
        if (resetView) {
            setFamilies(new Set());
            setSearch("");
            setShowInternal(false);
            setTab("overview");
        }
    }, []);

    const loadSession = useCallback(
        async (group: SourceGroup, session: SourceSession, background = false) => {
            if (background && refreshing.current) return;
            if (background) refreshing.current = true;
            else {
                setBusy(true);
                setStatus({ text: `正在读取 ${session.sessionId}…`, kind: "busy" });
            }
            try {
                const params = new URLSearchParams({ source: group.kind });
                // Both bridged sources need the pack: net routes by packId and
                // /connect commands are namespaced per pack.
                if (group.kind !== "ingest" && group.pack) params.set("pack", group.pack);
                const response = await fetch(
                    `/api/session/${encodeURIComponent(session.sessionId)}?${params}`
                );
                if (!response.ok) {
                    const detail = await response.json().catch(() => ({}));
                    throw new Error(detail.error ?? "读取失败");
                }
                const payload = new Uint8Array(await response.arrayBuffer());
                const data = await decodeBytes(payload);
                if (!data.ok || !data.selected) throw new Error(data.error ?? "解析失败");
                if (data.selected.end.endReason === "live-snapshot") data.selected.end.status = "running";
                selectedRef.current = { kind: group.kind, pack: group.pack, sessionId: session.sessionId };
                setSelectedKey(`${group.id}:${session.sessionId}`);
                setIsLive(true);
                setImportOpen(false);
                applyResult(data, sessionLabel(group, session.sessionId), !background);
                if (!background) setStatus({ text: `已载入 ${data.selected.events.length} 条事件` });
            } catch (error) {
                if (!background) setStatus({ text: (error as Error).message, kind: "error" });
            } finally {
                if (background) refreshing.current = false;
                else setBusy(false);
            }
        },
        [applyResult, decodeBytes]
    );

    // Keep a running live session fresh without disturbing the current view.
    const sourcesRef = useRef<SourceGroup[]>([]);
    useEffect(() => {
        sourcesRef.current = sources;
    }, [sources]);

    const liveSessionId = selected?.sessionId;
    const liveStatus = selected?.end.status;
    useEffect(() => {
        if (!isLive || !liveSessionId || liveStatus !== "running") return;
        const reference = selectedRef.current;
        if (!reference) return;
        const timer = window.setInterval(() => {
            const group = sourcesRef.current.find(
                (entry) => entry.id === reference.kind || entry.pack === reference.pack
            );
            const session = group?.sessions.find((entry) => entry.sessionId === reference.sessionId);
            if (group && session) void loadSession(group, session, true);
        }, 3000);
        return () => window.clearInterval(timer);
    }, [isLive, liveSessionId, liveStatus, loadSession]);

    // ------------------------------------------------------------------
    // Import
    // ------------------------------------------------------------------

    const decodeImport = useCallback(
        async (sessionId?: string) => {
            const payload = bytes ?? new TextEncoder().encode(input);
            if (payload.length === 0) {
                setStatus({ text: "请粘贴 Content Log 或选择 trace 文件", kind: "error" });
                setImportOpen(true);
                return;
            }
            setBusy(true);
            setStatus({ text: sessionId ? "正在切换会话…" : "正在解析 trace…", kind: "busy" });
            try {
                const data = await decodeBytes(payload, sessionId);
                if (data.ok && data.selected) {
                    selectedRef.current = null;
                    setSelectedKey(null);
                    setIsLive(false);
                    applyResult(data, sourceName || "导入的 trace");
                    setImportOpen(false);
                    setStatus({ text: `已载入 ${data.selected.events.length} 条事件` });
                } else {
                    setStatus({ text: data.error ?? "解析失败", kind: "error" });
                }
            } catch (error) {
                setStatus({ text: `请求失败：${(error as Error).message}`, kind: "error" });
            } finally {
                setBusy(false);
            }
        },
        [applyResult, bytes, decodeBytes, input, sourceName]
    );

    const loadFile = useCallback(async (file: File | null | undefined) => {
        if (!file) return;
        const loaded = new Uint8Array(await file.arrayBuffer());
        setBytes(loaded);
        setSourceName(file.name);
        if (file.size <= TEXT_PREVIEW_LIMIT && !file.name.endsWith(".begtrace")) {
            setInput(new TextDecoder("utf-8", { fatal: false }).decode(loaded));
        } else {
            setInput("");
        }
        setStatus({ text: `${file.name} · ${fmtBytes(file.size)}` });
    }, []);

    const clearImport = useCallback(() => {
        setInput("");
        setBytes(null);
        setSourceName("");
        if (fileRef.current) fileRef.current.value = "";
    }, []);

    // ------------------------------------------------------------------
    // Source actions
    // ------------------------------------------------------------------

    const exportGroup = useCallback(async (group: SourceGroup) => {
        if (group.kind === "ingest") return;
        setBusy(true);
        setStatus({ text: `正在导出 ${group.sessions.length} 局…`, kind: "busy" });
        try {
            const endpoint = group.kind === "net" ? "/api/net/export" : "/api/connect/export";
            // Both bridges address sessions per pack: the net bridge routes by
            // packId, and /connect commands are namespaced per pack.
            const body =
                group.kind === "net"
                    ? { items: group.sessions.map((session) => ({ source: group.pack, id: session.sessionId })) }
                    : { ids: group.sessions.map((session) => session.sessionId), pack: group.pack };
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error((await response.json()).error ?? "导出失败");
            const blob = await response.blob();
            const anchor = document.createElement("a");
            anchor.href = URL.createObjectURL(blob);
            anchor.download = group.kind === "net" ? "begame-bds-traces.zip" : "begame-traces.zip";
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(anchor.href), 60000);
            setStatus({ text: `已导出 ${group.sessions.length} 局` });
        } catch (error) {
            setStatus({ text: (error as Error).message, kind: "error" });
        } finally {
            setBusy(false);
        }
    }, []);

    const deleteSession = useCallback(
        async (group: SourceGroup, sessionId: string) => {
            if (group.kind !== "net" || !group.pack) return;
            setBusy(true);
            setStatus({ text: `正在删除 ${sessionId}…`, kind: "busy" });
            try {
                const response = await fetch(
                    `/api/net/session/${encodeURIComponent(sessionId)}?source=${encodeURIComponent(group.pack)}`,
                    { method: "DELETE" }
                );
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ?? "删除失败");
                if (selectedRef.current?.sessionId === sessionId) {
                    setResult(null);
                    setAnalysis(null);
                    selectedRef.current = null;
                }
                await refreshSources();
                setStatus({ text: data.deleted ? `已删除 ${sessionId}` : `未找到 ${sessionId}` });
            } catch (error) {
                setStatus({ text: (error as Error).message, kind: "error" });
            } finally {
                setBusy(false);
            }
        },
        [refreshSources]
    );

    const clearGroup = useCallback(
        async (group: SourceGroup) => {
            if (group.kind !== "net" || !group.pack) return;
            setBusy(true);
            setStatus({ text: "正在清空已完成会话…", kind: "busy" });
            try {
                const response = await fetch("/api/net/clear", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ source: group.pack }),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ?? "清空失败");
                await refreshSources();
                setStatus({ text: `已删除 ${data.removed} 局` });
            } catch (error) {
                setStatus({ text: (error as Error).message, kind: "error" });
            } finally {
                setBusy(false);
            }
        },
        [refreshSources]
    );

    const toggleStore = useCallback(
        async (group: SourceGroup, enabled: boolean) => {
            if (group.kind !== "net" || !group.pack) return;
            try {
                const response = await fetch("/api/net/store", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ source: group.pack, enabled }),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error ?? "切换失败");
                await refreshSources();
                setStatus({ text: `Trace Store 已${data.store.enabled ? "开启" : "关闭"}` });
            } catch (error) {
                setStatus({ text: (error as Error).message, kind: "error" });
            }
        },
        [refreshSources]
    );

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------

    const logExports = !isLive ? result?.exports ?? [] : [];
    const anySource = capabilities.connect || capabilities.net || capabilities.ingest || capabilities.archive;

    const toggleSource = useCallback((id: string) => {
        setCollapsedSources((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleAllSources = useCallback(() => {
        setCollapsedSources((previous) => {
            const allCollapsed = sources.length > 0 && sources.every((group) => previous.has(group.id));
            return allCollapsed ? new Set() : new Set(sources.map((group) => group.id));
        });
    }, [sources]);

    return (
        <div className="app-shell">
            <Sidebar
                health={health}
                version={version}
                capabilities={capabilities}
                sources={sources}
                collapsedSources={collapsedSources}
                onToggleSource={toggleSource}
                onToggleAllSources={toggleAllSources}
                selectedKey={selectedKey}
                logExports={logExports}
                currentSessionId={result?.selected?.sessionId ?? result?.requestedSessionId ?? ""}
                busy={busy}
                onImport={() => setImportOpen(true)}
                onSelectLog={(sessionId) => void decodeImport(sessionId)}
                onSelectSource={(group, session) => void loadSession(group, session)}
                onExportGroup={(group) => void exportGroup(group)}
                onDeleteSession={(group, id) => void deleteSession(group, id)}
                onClearGroup={(group) => void clearGroup(group)}
                onToggleStore={(group, enabled) => void toggleStore(group, enabled)}
                anySource={anySource}
            />

            <main className="workspace">
                <header className="workspace-bar">
                    <div className="breadcrumb">
                        <span>Observatory</span>
                        <span className="breadcrumb-separator">/</span>
                        <strong>{selected?.header.gameType ?? "工作台"}</strong>
                        {sourceName ? <span className="breadcrumb-source">{sourceName}</span> : null}
                    </div>
                    <div className="workspace-actions">
                        {status.text ? (
                            <span className={`status${status.kind ? ` ${status.kind}` : ""}`}>{status.text}</span>
                        ) : null}
                        <button className="button" onClick={() => setImportOpen(true)}>
                            导入 trace
                        </button>
                    </div>
                </header>

                <div className="workspace-content">
                    {importOpen ? (
                        <ImportPanel
                            input={input}
                            bytes={bytes}
                            busy={busy}
                            fileRef={fileRef}
                            onInput={(value) => {
                                setInput(value);
                                setBytes(null);
                                setSourceName(value ? "粘贴的 Content Log" : "");
                            }}
                            onFile={loadFile}
                            onDecode={() => void decodeImport()}
                            onClear={clearImport}
                            onClose={selected ? () => setImportOpen(false) : undefined}
                        />
                    ) : null}

                    {!selected ? (
                        <EmptyWorkspace
                            anySource={anySource}
                            capabilities={capabilities}
                            sources={sources}
                            onImport={() => setImportOpen(true)}
                        />
                    ) : analysis ? (
                        <>
                            <SessionHeader selected={selected} analysis={analysis} />
                            <nav className="view-tabs" aria-label="分析视图">
                                <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
                                    概览
                                </TabButton>
                                <TabButton active={tab === "stream"} onClick={() => setTab("stream")}>
                                    事件流
                                </TabButton>
                                <TabButton active={tab === "structure"} onClick={() => setTab("structure")}>
                                    结构
                                </TabButton>
                                <TabButton active={tab === "participants"} onClick={() => setTab("participants")}>
                                    参与者
                                </TabButton>
                                <TabButton active={tab === "raw"} onClick={() => setTab("raw")}>
                                    原始
                                </TabButton>
                            </nav>
                            <div className="view-stage">
                                {tab === "overview" ? (
                                    <OverviewView
                                        selected={selected}
                                        analysis={analysis}
                                        onInspectFamily={(family) => {
                                            setFamilies(new Set([family]));
                                            setTab("stream");
                                        }}
                                    />
                                ) : null}
                                {tab === "stream" ? (
                                    <StreamView
                                        selected={selected}
                                        analysis={analysis}
                                        families={families}
                                        onFamilies={setFamilies}
                                        showInternal={showInternal}
                                        onShowInternal={setShowInternal}
                                        search={search}
                                        onSearch={setSearch}
                                    />
                                ) : null}
                                {tab === "structure" ? <StructureView selected={selected} analysis={analysis} /> : null}
                                {tab === "participants" ? (
                                    <ParticipantsView selected={selected} analysis={analysis} />
                                ) : null}
                                {tab === "raw" ? <RawView selected={selected} analysis={analysis} /> : null}
                            </div>
                        </>
                    ) : (
                        <div className="empty">解析结果缺少分析数据。</div>
                    )}
                </div>
            </main>
        </div>
    );
}

function sessionLabel(group: SourceGroup, sessionId: string): string {
    const kind = group.kind === "net" ? "BDS" : group.kind === "connect" ? "/connect" : "ingest";
    const pack = group.packName ?? group.pack;
    return `${kind}${pack ? ` · ${pack}` : ""} · ${sessionId}`;
}

function Sidebar({
    health,
    version,
    capabilities,
    sources,
    collapsedSources,
    onToggleSource,
    onToggleAllSources,
    selectedKey,
    logExports,
    currentSessionId,
    busy,
    onImport,
    onSelectLog,
    onSelectSource,
    onExportGroup,
    onDeleteSession,
    onClearGroup,
    onToggleStore,
    anySource,
}: {
    health: Health;
    version: string;
    capabilities: Capabilities;
    sources: SourceGroup[];
    collapsedSources: Set<string>;
    onToggleSource: (id: string) => void;
    onToggleAllSources: () => void;
    selectedKey: string | null;
    logExports: TraceExportMeta[];
    currentSessionId: string;
    busy: boolean;
    onImport: () => void;
    onSelectLog: (sessionId: string) => void;
    onSelectSource: (group: SourceGroup, session: SourceSession) => void;
    onExportGroup: (group: SourceGroup) => void;
    onDeleteSession: (group: SourceGroup, sessionId: string) => void;
    onClearGroup: (group: SourceGroup) => void;
    onToggleStore: (group: SourceGroup, enabled: boolean) => void;
    anySource: boolean;
}) {
    const allCollapsed =
        sources.length > 0 && sources.every((group) => collapsedSources.has(group.id));
    return (
        <aside className="sidebar">
            <div className="brand">
                <div className="brand-mark" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                </div>
                <div>
                    <div className="brand-name">BEGame</div>
                    <div className="brand-product">Observatory</div>
                </div>
            </div>

            <button className="new-source" onClick={onImport}>
                <span>＋</span> 导入数据源
            </button>

            {logExports.length > 0 ? (
                <section className="side-section">
                    <div className="side-heading">
                        <span>日志中的会话</span>
                        <span>{logExports.length}</span>
                    </div>
                    <div className="session-list">
                        {logExports.map((entry, index) => (
                            <button
                                key={entry.sessionId}
                                className={`session-item${entry.sessionId === currentSessionId ? " active" : ""}`}
                                disabled={busy || !entry.complete}
                                onClick={() => onSelectLog(entry.sessionId)}
                                title={entry.sessionId}
                            >
                                <span className="session-index">{String(index + 1).padStart(2, "0")}</span>
                                <span className="session-copy">
                                    <strong>{entry.sessionId}</strong>
                                    <span>
                                        {entry.complete
                                            ? `${entry.partCount} 个分片 · 完整`
                                            : `缺少 ${entry.missingParts.join(", ")}`}
                                    </span>
                                </span>
                                <span className={`session-state${entry.complete ? " complete" : " incomplete"}`} />
                            </button>
                        ))}
                    </div>
                </section>
            ) : null}

            <section className="side-section grow">
                <div className="side-heading">
                    <span>游戏数据源</span>
                    <span className="side-heading-right">
                        {sources.length > 0 ? (
                            <button className="link-btn" onClick={onToggleAllSources}>
                                {allCollapsed ? "展开" : "收起"}
                            </button>
                        ) : null}
                        <span>{sources.reduce((sum, group) => sum + group.sessions.length, 0)}</span>
                    </span>
                </div>
                {sources.length === 0 ? (
                    <div className="side-empty">
                        {anySource ? "等待游戏连接" : "未启用任何数据源"}
                    </div>
                ) : null}
                {sources.map((group) => {
                    const collapsed = collapsedSources.has(group.id);
                    return (
                        <div className={`source-group${collapsed ? " collapsed" : ""}`} key={group.id}>
                            <div className="source-head">
                                <button
                                    className="source-toggle"
                                    onClick={() => onToggleSource(group.id)}
                                    aria-expanded={!collapsed}
                                    title={collapsed ? "展开" : "收起"}
                                >
                                    <span className="source-caret" aria-hidden="true">
                                        {collapsed ? "▸" : "▾"}
                                    </span>
                                    <span className={`source-dot ${group.connected ? "on" : ""}`} />
                                    <span className="source-title">
                                        <strong>{sourceGroupLabel(group)}</strong>
                                        <span>
                                            {group.kind === "net" && group.store
                                                ? `Store ${group.store.enabled ? "ON" : "OFF"} · ${group.store.count} 局`
                                                : group.connected
                                                  ? "已连接"
                                                  : "未连接"}
                                        </span>
                                    </span>
                                    <span className="source-count">{group.sessions.length}</span>
                                </button>
                                {group.kind === "net" && group.connected ? (
                                    <button
                                        className={`store-toggle${group.store?.enabled ? " on" : ""}`}
                                        disabled={busy}
                                        onClick={() => onToggleStore(group, !(group.store?.enabled ?? false))}
                                        title="切换 Trace Store"
                                    >
                                        Store
                                    </button>
                                ) : null}
                            </div>
                            {collapsed ? null : (
                                <>
                                    {group.error ? <div className="source-error">{group.error}</div> : null}
                                    <div className="session-list nested">
                                        {group.sessions.map((session) => {
                                            const key = `${group.id}:${session.sessionId}`;
                                            return (
                                                <div className="session-row" key={key}>
                                                    <button
                                                        className={`session-item${key === selectedKey ? " active" : ""}`}
                                                        disabled={busy}
                                                        onClick={() => onSelectSource(group, session)}
                                                        title={session.sessionId}
                                                    >
                                                        <span className="session-copy">
                                                            <strong>{session.gameType ?? session.sessionId}</strong>
                                                            <span className="mono">{session.sessionId}</span>
                                                            <span>
                                                                {session.status === "running" ? "进行中" : "可查看"}
                                                                {session.archived ? " · 已归档" : ""}
                                                                {session.eventCount !== undefined ? ` · ${session.eventCount} 事件` : ""}
                                                                {session.storedBytes !== undefined ? ` · ${fmtBytes(session.storedBytes)}` : ""}
                                                                {session.bytes !== undefined ? ` · ${fmtBytes(session.bytes)}` : ""}
                                                            </span>
                                                        </span>
                                                        <span className={`session-state${session.status === "running" ? " incomplete" : " complete"}`} />
                                                    </button>
                                                    {group.kind === "net" ? (
                                                        <button
                                                            className="icon-button"
                                                            disabled={busy}
                                                            onClick={() => onDeleteSession(group, session.sessionId)}
                                                            title="删除该会话"
                                                            aria-label="删除该会话"
                                                        >
                                                            ×
                                                        </button>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                        {group.sessions.length === 0 ? <div className="side-empty small">暂无会话</div> : null}
                                    </div>
                                    {group.kind !== "ingest" && group.sessions.length > 0 ? (
                                        <div className="source-actions">
                                            <button className="btn" disabled={busy} onClick={() => onExportGroup(group)}>
                                                导出 ZIP
                                            </button>
                                            {group.kind === "net" ? (
                                                <button className="btn" disabled={busy} onClick={() => onClearGroup(group)}>
                                                    清空已完成
                                                </button>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </>
                            )}
                        </div>
                    );
                })}
            </section>

            <div className="sidebar-spacer" />

            <section className="connection-card">
                <div className="connection-row">
                    <span className={`connection-dot ${health}`} />
                    <div>
                        <strong>{health === "ok" ? "本地服务" : health === "bad" ? "服务离线" : "正在连接"}</strong>
                        <span>{health === "ok" ? `API v${version}` : "127.0.0.1"}</span>
                    </div>
                    <span className="connection-mode">LOCAL</span>
                </div>
                <div className="capability-row-inline">
                    <span className={capabilities.connect ? "on" : ""}>/connect</span>
                    <span className={capabilities.net ? "on" : ""}>net</span>
                    <span className={capabilities.ingest ? "on" : ""}>ingest</span>
                    <span className={capabilities.archive ? "on" : ""}>归档</span>
                </div>
            </section>
        </aside>
    );
}

function sourceGroupLabel(group: SourceGroup): string {
    // Both bridges are per pack, so the label names the pack rather than the
    // transport; otherwise two /connect groups look identical.
    if (group.kind === "connect") return `/connect · ${group.packName ?? group.pack ?? "pack"}`;
    if (group.kind === "ingest") return "HTTP 上传";
    return `BDS · ${group.packName ?? group.pack ?? "pack"}`;
}

function SessionHeader({
    selected,
    analysis,
}: {
    selected: NonNullable<DecodeResponse["selected"]>;
    analysis: SessionAnalysis;
}) {
    const tone = analysis.status === "completed" ? "healthy" : analysis.status === "running" ? "running" : "attention";
    return (
        <section className="session-header">
            <div>
                <div className="session-kicker">
                    <span className={`run-status ${tone}`} />
                    {analysis.status === "completed" ? "追踪已完成" : analysis.status}
                    {analysis.endReason ? ` · ${analysis.endReason}` : ""}
                </div>
                <h1>{selected.header.gameType}</h1>
                <div className="session-subtitle">
                    <code>{selected.header.gameKey}</code>
                    <span>·</span>
                    <span>{fmtDate(selected.header.startWallTime)}</span>
                </div>
            </div>
            <div className="session-facts">
                <div>
                    <span>事件</span>
                    <strong>{analysis.eventCount.toLocaleString("zh-CN")}</strong>
                </div>
                <div>
                    <span>诊断</span>
                    <strong className={analysis.errorCount > 0 ? "bad-text" : "ok-text"}>{analysis.errorCount}</strong>
                </div>
                <div>
                    <span>参与者</span>
                    <strong>{analysis.playerCount}</strong>
                </div>
            </div>
        </section>
    );
}

function ImportPanel({
    input,
    bytes,
    busy,
    fileRef,
    onInput,
    onFile,
    onDecode,
    onClear,
    onClose,
}: {
    input: string;
    bytes: Uint8Array | null;
    busy: boolean;
    fileRef: React.RefObject<HTMLInputElement | null>;
    onInput: (value: string) => void;
    onFile: (file: File | null | undefined) => void;
    onDecode: () => void;
    onClear: () => void;
    onClose?: () => void;
}) {
    return (
        <section className="import-panel">
            <div className="import-head">
                <div>
                    <span className="eyebrow">DATA SOURCE</span>
                    <h2>载入一次离线追踪</h2>
                    <p>支持 Content Log、文本日志和原始 .begtrace 容器。</p>
                </div>
                {onClose ? (
                    <button className="icon-button" onClick={onClose} aria-label="关闭导入面板">
                        ×
                    </button>
                ) : null}
            </div>
            <div
                className="drop-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                    event.preventDefault();
                    void onFile(event.dataTransfer.files?.[0]);
                }}
            >
                <textarea
                    value={input}
                    spellCheck={false}
                    disabled={Boolean(bytes && !input)}
                    placeholder="粘贴包含 [BEGAME_TRACE:…] 的 Content Log"
                    onChange={(event) => onInput(event.target.value)}
                    onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                            event.preventDefault();
                            onDecode();
                        }
                    }}
                />
                <div className="drop-actions">
                    <label className="button quiet">
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".log,.txt,.begtrace"
                            hidden
                            onChange={(event) => {
                                void onFile(event.target.files?.[0]);
                                event.target.value = "";
                            }}
                        />
                        选择文件
                    </label>
                    <span>或拖放到这里 · Ctrl+Enter 解析</span>
                    <div className="drop-spacer" />
                    {input || bytes ? (
                        <button className="button ghost" onClick={onClear}>
                            清空
                        </button>
                    ) : null}
                    <button className="button primary" disabled={busy} onClick={onDecode}>
                        {busy ? "解析中…" : "开始分析"}
                    </button>
                </div>
            </div>
        </section>
    );
}

function EmptyWorkspace({
    anySource,
    capabilities,
    sources,
    onImport,
}: {
    anySource: boolean;
    capabilities: Capabilities;
    sources: SourceGroup[];
    onImport: () => void;
}) {
    return (
        <section className="empty-workspace">
            <span className="eyebrow">TRACE ANALYSIS WORKSPACE</span>
            <h1>从一次对局，看见整个运行时。</h1>
            <p>载入 trace 后，在同一处检查事件族、状态与组件生命周期、参与者、诊断和每一条原始事件。</p>
            <button className="button primary large" onClick={onImport}>
                选择 trace 文件
            </button>
            <div className="hint-grid">
                <div>
                    <h3>数据源</h3>
                    {anySource ? (
                        <p>
                            已启用：
                            {[capabilities.connect ? "/connect" : null, capabilities.net ? "BDS net" : null, capabilities.ingest ? "ingest" : null, capabilities.archive ? "本地归档" : null]
                                .filter(Boolean)
                                .join("、")}
                            。左侧会自动列出会话。
                        </p>
                    ) : (
                        <p>
                            未启用游戏数据源。用 <code>--connect</code>、<code>--net</code> 或{" "}
                            <code>--ingest</code> 启动 Observatory 后，左侧会自动列出会话。
                        </p>
                    )}
                </div>
                <div>
                    <h3>Agent 接口</h3>
                    <p>
                        <code>POST /api/analyze</code> 返回结构化分析；
                        <code>GET /api/analyze?source=&amp;id=</code> 直接分析已连接会话；
                        <code>GET /api/sessions</code> 汇总全部数据源。
                    </p>
                </div>
                <div>
                    <h3>当前状态</h3>
                    <p>
                        {sources.length === 0
                            ? "尚未发现任何数据源。"
                            : `发现 ${sources.length} 个数据源，共 ${sources.reduce((sum, group) => sum + group.sessions.length, 0)} 个会话。`}
                    </p>
                </div>
            </div>
        </section>
    );
}

function TabButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button className={active ? "active" : ""} onClick={onClick}>
            {children}
        </button>
    );
}
