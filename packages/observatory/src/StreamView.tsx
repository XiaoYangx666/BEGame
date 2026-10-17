import { useMemo, useState } from "react";
import type { EventFamily, SelectedSession, SessionAnalysis } from "./types";
import {
    eventFamily,
    eventSeverity,
    eventSubtype,
    eventTitle,
    isInternalEvent,
    summarizeEvent,
} from "./analysis.mjs";
import {
    FAMILY_LABELS,
    FAMILY_ORDER,
    FamilyBadge,
    PayloadChips,
    SeverityDot,
} from "./components";
import { fmtRel } from "./format";

const PAGE_SIZE = 400;

interface Props {
    selected: SelectedSession;
    analysis: SessionAnalysis;
    families: Set<EventFamily>;
    onFamilies: (next: Set<EventFamily>) => void;
    showInternal: boolean;
    onShowInternal: (value: boolean) => void;
    search: string;
    onSearch: (value: string) => void;
}

interface Row {
    event: SelectedSession["events"][number];
    index: number;
    owner: string;
}

export function StreamView({
    selected,
    analysis,
    families,
    onFamilies,
    showInternal,
    onShowInternal,
    search,
    onSearch,
}: Props) {
    const [limit, setLimit] = useState(PAGE_SIZE);
    const nodeNames = useMemo(
        () => new Map(analysis.stateTree.map((node) => [node.key, node.name])),
        [analysis]
    );

    const rows = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const list: Row[] = [];
        selected.events.forEach((event, index) => {
            const family = eventFamily(event.type, event.source.kind);
            if (families.size > 0 && !families.has(family)) return;
            if (!showInternal && isInternalEvent(event.type)) return;
            const subtype = eventSubtype(event);
            if (needle) {
                const haystack = [
                    event.type,
                    subtype ?? "",
                    event.source.kind,
                    event.source.name ?? "",
                    JSON.stringify(event.payload),
                ]
                    .join(" ")
                    .toLowerCase();
                if (!haystack.includes(needle)) return;
            }
            list.push({ event, index, owner: selected.context.eventOwners[index] ?? "session" });
        });
        return list;
    }, [selected, families, showInternal, search]);

    // Consecutive events that share an owning scope form one section.
    const sections = useMemo(() => {
        const result: Array<{ owner: string; rows: Row[] }> = [];
        for (const row of rows) {
            const last = result.at(-1);
            if (!last || last.owner !== row.owner) result.push({ owner: row.owner, rows: [row] });
            else last.rows.push(row);
        }
        return result;
    }, [rows]);

    const shown = rows.slice(0, limit);
    const shownSections = useMemo(() => {
        const visible = new Set(shown.map((row) => row.index));
        return sections
            .map((section) => ({
                owner: section.owner,
                rows: section.rows.filter((row) => visible.has(row.index)),
            }))
            .filter((section) => section.rows.length > 0);
    }, [sections, shown]);

    const toggleFamily = (family: EventFamily) => {
        const next = new Set(families);
        if (next.has(family)) next.delete(family);
        else next.add(family);
        onFamilies(next);
        setLimit(PAGE_SIZE);
    };

    return (
        <div className="panel">
            <header className="panel-head">
                <div className="panel-title">
                    <h2>事件流</h2>
                    <span className="meta">
                        显示 {shown.length} / 匹配 {rows.length} / 共 {selected.events.length}
                    </span>
                </div>
                <div className="toolbar">
                    <input
                        className="filter"
                        placeholder="搜索 type / source / payload"
                        value={search}
                        onChange={(event) => {
                            onSearch(event.target.value);
                            setLimit(PAGE_SIZE);
                        }}
                    />
                    <label className="toggle">
                        <input
                            type="checkbox"
                            checked={showInternal}
                            onChange={(event) => {
                                onShowInternal(event.target.checked);
                                setLimit(PAGE_SIZE);
                            }}
                        />
                        显示内部事件 ({analysis.internalCount})
                    </label>
                </div>
            </header>

            <div className="family-filters">
                {FAMILY_ORDER.map((family) => {
                    const count = analysis.families[family] ?? 0;
                    const active = families.has(family);
                    return (
                        <button
                            key={family}
                            className={`family-filter family-${family}${active ? " active" : ""}`}
                            disabled={count === 0}
                            onClick={() => toggleFamily(family)}
                            title={`${FAMILY_LABELS[family]}：${count} 条`}
                        >
                            {FAMILY_LABELS[family]}
                            <b>{count}</b>
                        </button>
                    );
                })}
                {families.size > 0 ? (
                    <button className="btn" onClick={() => onFamilies(new Set())}>
                        清除筛选
                    </button>
                ) : null}
            </div>

            <div className="stream">
                {shownSections.map((section, sectionIndex) => {
                    const first = section.rows[0];
                    const last = section.rows.at(-1)!;
                    return (
                        <section className="stream-section" key={`${section.owner}-${sectionIndex}`}>
                            <header className="stream-head">
                                <span className="stream-scope">
                                    {nodeNames.get(section.owner) ?? "会话"}
                                </span>
                                <span className="meta">
                                    {fmtRel(analysis.startTick, first.event.tick)} →{" "}
                                    {fmtRel(analysis.startTick, last.event.tick)} · {section.rows.length} 条
                                </span>
                            </header>
                            <div className="stream-body">
                                {section.rows.map(({ event }) => (
                                    <StreamRow
                                        key={event.sequence}
                                        event={event}
                                        startTick={analysis.startTick}
                                        owner={nodeNames.get(section.owner) ?? "会话"}
                                    />
                                ))}
                            </div>
                        </section>
                    );
                })}
                {rows.length === 0 ? (
                    <div className="empty">没有符合筛选条件的事件。</div>
                ) : null}
            </div>

            {rows.length > shown.length ? (
                <button className="btn more" onClick={() => setLimit(limit + PAGE_SIZE)}>
                    加载更多（剩余 {rows.length - shown.length}）
                </button>
            ) : null}
        </div>
    );
}

function StreamRow({
    event,
    startTick,
    owner,
}: {
    event: SelectedSession["events"][number];
    startTick: number;
    owner: string;
}) {
    const family = eventFamily(event.type, event.source.kind) as EventFamily;
    const severity = eventSeverity(event.type);
    const title = eventTitle(event);
    const summary = summarizeEvent(event);
    return (
        <details className={`stream-row${severity === "error" ? " error" : ""}`}>
            <summary>
                <span className="row-time" title={`tick ${event.tick} · #${event.sequence}`}>
                    {fmtRel(startTick, event.tick)}
                </span>
                <SeverityDot severity={severity} />
                <FamilyBadge family={family} />
                <span className="row-title">
                    {title}
                    {title !== event.type ? <code className="raw-type">{event.type}</code> : null}
                </span>
                <span className="row-summary" title={summary}>
                    {summary}
                </span>
            </summary>
            <div className="row-detail">
                <div className="row-detail-meta">
                    <span>#{event.sequence}</span>
                    <span>tick {event.tick}</span>
                    <span>来源 {event.source.kind}{event.source.name ? ` · ${event.source.name}` : ""}</span>
                    <span>归属 {owner}</span>
                </div>
                <PayloadChips payload={event.payload} />
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </div>
        </details>
    );
}
