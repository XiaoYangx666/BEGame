export interface TraceSessionHeader {
    sessionId: string;
    formatVersion: number;
    gameType: string;
    gameKey: string;
    gameInstanceId: string;
    begameVersion?: string;
    packVersion?: string;
    startTick: number;
    startWallTime: number;
    initialConfig?: unknown;
}

export interface TraceSessionEnd {
    sessionId: string;
    status: string;
    endTick: number;
    endWallTime: number;
    endReason?: string;
    eventCount: number;
    chunkCount: number;
}

export interface TraceSource {
    kind: string;
    ref?: number;
    name?: string;
}

export interface TraceEvent {
    sequence: number;
    tick: number;
    typeId: number;
    type: string;
    source: TraceSource;
    payload: unknown;
}

export interface StateSpan {
    ref: number;
    name: string;
    depth: number | null;
    enterTick: number;
    enterSequence: number;
    exitTick: number;
    exitSequence: number;
}

export interface TraceStats {
    tickSpan: number;
    wallSpanMs: number;
    eventCount: number;
    chunkCount: number;
    typeCounts: Record<string, number>;
    sourceCounts: Record<string, number>;
    stateSpans: StateSpan[];
}

export interface ContextNode {
    key: string;
    ref: number | null;
    name: string;
    depth: number | null;
    parentKey: string | null;
    children: string[];
    enterTick: number;
    exitTick: number | null;
    enterSequence: number;
    exitSequence: number | null;
    pushSequence: number | null;
    removeSequence: number | null;
    eventCount: number;
    errorCount: number;
}

export interface PlayerEntry {
    id: string;
    name?: string;
    seats: (string | number)[];
    firstSequence: number;
    lastSequence: number;
}

export interface SeatChange {
    sequence: number;
    tick: number;
    kind?: string;
    name?: string;
    participantId?: string;
}

export interface SeatEntry {
    seat: string | number;
    name?: string;
    kind?: string;
    participantId?: string;
    firstSequence: number;
    lastSequence: number;
    changes: SeatChange[];
}

export interface ContextIssue {
    eventIndex: number;
    nodeKey: string;
    type: string;
}

export interface TraceContext {
    nodes: ContextNode[];
    eventOwners: string[];
    players: PlayerEntry[];
    seats: SeatEntry[];
    errors: ContextIssue[];
}

export interface TraceExportMeta {
    sessionId: string;
    formatVersion: number;
    partCount: number;
    receivedParts: number[];
    missingParts: number[];
    complete: boolean;
    lastOffset: number;
}

export interface SelectedSession {
    sessionId: string;
    header: TraceSessionHeader;
    end: TraceSessionEnd;
    events: TraceEvent[];
    stats: TraceStats;
    context: TraceContext;
    /** Attached by the decoder; see `analyzeSession` in analysis.mjs. */
    analysis?: SessionAnalysis;
}

export type EventFamily =
    | "game"
    | "state"
    | "component"
    | "participation"
    | "connection"
    | "timeout"
    | "runtime"
    | "debug"
    | "domain";

export type EventSeverity = "normal" | "muted" | "accent" | "error";

export interface DomainTypeEntry {
    type: string;
    subtype?: string;
    count: number;
    firstSequence: number;
    lastSequence: number;
}

export interface DomainEventEntry {
    index: number;
    sequence: number;
    tick: number;
    type: string;
    subtype?: string;
    scope: string;
    severity: EventSeverity;
    summary: string;
    payload: unknown;
}

export interface ComponentEntry {
    ref: number;
    name: string;
    firstSequence: number;
    lastSequence: number;
    attachedTick: number | null;
    detachedTick: number | null;
    events: number;
    errorCount: number;
}

export interface AnalysisDiagnostic {
    index: number;
    sequence: number;
    tick: number;
    type: string;
    subtype?: string;
    family: EventFamily;
    scope: string;
    message?: string;
    payload: unknown;
}

export interface SessionAnalysis {
    sessionId: string;
    gameType: string;
    gameKey: string;
    gameInstanceId: string;
    status: string;
    endReason?: string;
    startTick: number;
    endTick: number;
    startWallTime: number;
    endWallTime: number;
    durationMs: number;
    tickSpan: number;
    eventCount: number;
    chunkCount: number;
    families: Record<EventFamily, number>;
    severities: Record<EventSeverity, number>;
    typeCounts: Record<string, number>;
    sourceCounts: Record<string, number>;
    internalCount: number;
    internalByType: Record<string, number>;
    playerCount: number;
    seatCount: number;
    errorCount: number;
    domainCount: number;
    players: PlayerEntry[];
    seats: SeatEntry[];
    stateTree: ContextNode[];
    components: ComponentEntry[];
    domainTypes: DomainTypeEntry[];
    domainEvents: DomainEventEntry[];
    diagnostics: AnalysisDiagnostic[];
}

export interface DecodeResponse {
    ok: boolean;
    source?: "log" | "begtrace";
    error?: string;
    warnings?: string[];
    exports?: TraceExportMeta[];
    selectedSessionId?: string;
    requestedSessionId?: string;
    selected?: SelectedSession;
    analysis?: SessionAnalysis;
}
