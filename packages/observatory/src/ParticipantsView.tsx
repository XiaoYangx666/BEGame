import type { EventFamily, SelectedSession, SessionAnalysis } from "./types";
import { eventFamily, eventTitle } from "./analysis.mjs";
import { Empty, FamilyBadge, Panel, PayloadChips } from "./components";
import { fmtRel, fmtSeconds } from "./format";

interface Props {
    selected: SelectedSession;
    analysis: SessionAnalysis;
}

const WATCHED = new Set(["participation", "connection", "timeout"]);
// Game-independent convention: seat and membership change records belong
// alongside built-in participation events, not only in the raw stream.
const isParticipationChange = (type: string) =>
    type.endsWith(".seat.changed") || type.endsWith(".member.changed");

export function ParticipantsView({ selected, analysis }: Props) {
    const tickOfSequence = new Map(selected.events.map((event) => [event.sequence, event.tick]));
    const timeline = selected.events.filter((event) => WATCHED.has(eventFamily(event.type)) || isParticipationChange(event.type));

    return (
        <>
            <Panel title="参与者" meta={`${analysis.playerCount} 位`}>
                {analysis.players.length === 0 ? (
                    <Empty>没有参与者事件。</Empty>
                ) : (
                    <div className={`table player-table${analysis.seatCount > 0 ? "" : " no-seat"}`}>
                        <div className="table-head">
                            <span>名字</span>
                            <span>ID</span>
                            {analysis.seatCount > 0 ? <span>座位</span> : null}
                            <span>首次出现</span>
                            <span>最近活跃</span>
                        </div>
                        {analysis.players.map((player) => (
                            <div className="table-row" key={player.id}>
                                <span>{player.name ?? "—"}</span>
                                <span className="mono">{player.id}</span>
                                {analysis.seatCount > 0 ? (
                                    <span>{player.seats.length > 0 ? player.seats.join(" / ") : "—"}</span>
                                ) : null}
                                <span>
                                    {fmtRel(analysis.startTick, tickOfSequence.get(player.firstSequence) ?? analysis.startTick)}
                                </span>
                                <span>
                                    {fmtRel(analysis.startTick, tickOfSequence.get(player.lastSequence) ?? analysis.startTick)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </Panel>

            {/* Seat data is optional: only games that emit a `seat` field have it. */}
            {analysis.seatCount > 0 ? (
                <Panel title="座位占用" meta={`${analysis.seatCount} 个`}>
                    <div className="seat-grid">
                        {analysis.seats.map((seat) => (
                            <article className="seat-card" key={seat.seat}>
                                <header>
                                    <strong>座位 {seat.seat}</strong>
                                    <span className={`seat-kind ${seat.kind ?? "unknown"}`}>
                                        {seat.kind ?? "未知"}
                                    </span>
                                </header>
                                <div className="seat-current">
                                    {seat.name ?? seat.participantId ?? (seat.kind === "bot" ? "人机" : "空")}
                                </div>
                                <ol className="seat-history">
                                    {seat.changes.map((change, index) => (
                                        <li key={index}>
                                            <span className="mono">{fmtRel(analysis.startTick, change.tick)}</span>
                                            <span>
                                                {change.kind === "empty"
                                                    ? "清空"
                                                    : `${change.name ?? change.participantId ?? (change.kind === "bot" ? "人机" : "?")} 入座`}
                                                {change.kind && change.kind !== "empty"
                                                    ? `（${change.kind}）`
                                                    : ""}
                                            </span>
                                        </li>
                                    ))}
                                </ol>
                            </article>
                        ))}
                    </div>
                </Panel>
            ) : null}

            <Panel title="参与 / 连接时间线" meta={`${timeline.length} 条`}>
                {timeline.length === 0 ? (
                    <Empty>没有参与或连接事件。</Empty>
                ) : (
                    <div className="timeline-list">
                        {timeline.map((event) => {
                            const title = eventTitle(event);
                            return (
                                <div className="timeline-item" key={event.sequence}>
                                    <span className="mono timeline-time">
                                        {fmtRel(analysis.startTick, event.tick)}
                                    </span>
                                    <FamilyBadge family={eventFamily(event.type) as EventFamily} />
                                    <span className="timeline-title">
                                        {title}
                                        {title !== event.type ? <code className="raw-type">{event.type}</code> : null}
                                    </span>
                                    <PayloadChips payload={event.payload} />
                                </div>
                            );
                        })}
                    </div>
                )}
            </Panel>

            <Panel title="记录区间" meta={`${fmtSeconds(analysis.tickSpan / 20)} 游戏内`}>
                <div className="facts">
                    <div>
                        <dt>开始 tick</dt>
                        <dd className="mono">{analysis.startTick}</dd>
                    </div>
                    <div>
                        <dt>结束 tick</dt>
                        <dd className="mono">{analysis.endTick}</dd>
                    </div>
                    <div>
                        <dt>事件总数</dt>
                        <dd className="mono">{analysis.eventCount}</dd>
                    </div>
                </div>
            </Panel>
        </>
    );
}
