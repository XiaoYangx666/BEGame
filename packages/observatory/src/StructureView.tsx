import type { ContextNode, SelectedSession, SessionAnalysis } from "./types";
import { Empty, Panel } from "./components";
import { fmtRel, fmtSeconds } from "./format";

interface Props {
    selected: SelectedSession;
    analysis: SessionAnalysis;
}

export function StructureView({ analysis }: Props) {
    // The synthetic "session" node is the tree root; it must never be filed
    // under itself, or the tree would recurse without bound.
    const children = new Map<string, ContextNode[]>();
    for (const node of analysis.stateTree) {
        if (node.key === "session") continue;
        const parent = node.parentKey && node.parentKey !== node.key ? node.parentKey : "session";
        const list = children.get(parent) ?? [];
        list.push(node);
        children.set(parent, list);
    }
    const root = analysis.stateTree.find((node) => node.key === "session");
    const span = Math.max(1, analysis.tickSpan);

    return (
        <>
            <Panel title="状态树" meta={`${analysis.stateTree.length - 1} 个状态实例`}>
                {!root ? (
                    <Empty>没有状态事件。</Empty>
                ) : analysis.stateTree.length === 1 ? (
                    <Empty>此录制未包含状态栈生命周期，全部事件归属会话根节点；玩家和席位信息请查看“参与者”。</Empty>
                ) : (
                    <div className="tree">
                        <TreeRow
                            node={root}
                            children={children}
                            analysis={analysis}
                            span={span}
                            visited={new Set()}
                        />
                    </div>
                )}
            </Panel>

            <Panel title="组件生命周期" meta={`${analysis.components.length} 个实例`}>
                {analysis.components.length === 0 ? (
                    <Empty>没有组件事件。</Empty>
                ) : (
                    <div className="table component-table">
                        <div className="table-head">
                            <span>组件</span>
                            <span>挂载</span>
                            <span>卸载</span>
                            <span>事件</span>
                            <span>错误</span>
                        </div>
                        {analysis.components.map((component) => (
                            <div className="table-row" key={component.ref}>
                                <span className="mono">{component.name}</span>
                                <span>
                                    {component.attachedTick !== null
                                        ? fmtRel(analysis.startTick, component.attachedTick)
                                        : "—"}
                                </span>
                                <span>
                                    {component.detachedTick !== null
                                        ? fmtRel(analysis.startTick, component.detachedTick)
                                        : "—"}
                                </span>
                                <span>{component.events}</span>
                                <span className={component.errorCount > 0 ? "bad-text" : ""}>
                                    {component.errorCount}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </Panel>
        </>
    );
}

function TreeRow({
    node,
    children,
    analysis,
    span,
    visited,
}: {
    node: ContextNode;
    children: Map<string, ContextNode[]>;
    analysis: SessionAnalysis;
    span: number;
    visited: Set<string>;
}) {
    // A malformed or re-pushed state ref must not be able to loop forever.
    if (visited.has(node.key)) return null;
    visited.add(node.key);

    const kids = (children.get(node.key) ?? []).filter((child) => !visited.has(child.key));
    const depth = node.depth === null ? 0 : Math.max(0, node.depth);
    const exitTick = node.exitTick ?? analysis.endTick;
    const left = ((node.enterTick - analysis.startTick) / span) * 100;
    const width = ((exitTick - node.enterTick) / span) * 100;
    return (
        <>
            <div className="tree-row" style={{ paddingLeft: `${depth * 18}px` }}>
                <span className="tree-name">
                    {node.key === "session" ? "会话" : node.name}
                    {node.depth !== null && node.key !== "session" ? (
                        <em className="depth">d{node.depth}</em>
                    ) : null}
                </span>
                <span className="tree-track">
                    <span
                        className="tree-bar"
                        style={{
                            left: `${Math.max(0, Math.min(100, left))}%`,
                            width: `${Math.max(0.3, Math.min(100 - left, width))}%`,
                        }}
                        title={`tick ${node.enterTick} → ${exitTick}`}
                    />
                </span>
                <span className="tree-duration">{fmtSeconds((exitTick - node.enterTick) / 20)}</span>
                <span className="tree-count">{node.eventCount} 事件</span>
                {node.errorCount > 0 ? <span className="tree-errors">{node.errorCount} 错误</span> : null}
            </div>
            {kids.map((child) => (
                <TreeRow
                    key={child.key}
                    node={child}
                    children={children}
                    analysis={analysis}
                    span={span}
                    visited={visited}
                />
            ))}
        </>
    );
}
