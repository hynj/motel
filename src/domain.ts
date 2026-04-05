export type TraceSpanStatus = "ok" | "error"

export interface TraceSpanEvent {
	readonly name: string
	readonly timestamp: Date
	readonly attributes: Readonly<Record<string, string>>
}

export interface TraceSpanItem {
	readonly spanId: string
	readonly parentSpanId: string | null
	readonly serviceName: string
	readonly scopeName: string | null
	readonly kind: string | null
	readonly operationName: string
	readonly startTime: Date
	readonly durationMs: number
	readonly status: TraceSpanStatus
	readonly depth: number
	readonly tags: Readonly<Record<string, string>>
	readonly warnings: readonly string[]
	readonly events: readonly TraceSpanEvent[]
}

export interface TraceItem {
	readonly traceId: string
	readonly serviceName: string
	readonly rootOperationName: string
	readonly startedAt: Date
	readonly durationMs: number
	readonly spanCount: number
	readonly errorCount: number
	readonly warnings: readonly string[]
	readonly spans: readonly TraceSpanItem[]
}

export interface TraceSummaryItem {
	readonly traceId: string
	readonly serviceName: string
	readonly rootOperationName: string
	readonly startedAt: Date
	readonly durationMs: number
	readonly spanCount: number
	readonly errorCount: number
	readonly warnings: readonly string[]
}

export interface SpanItem {
	readonly traceId: string
	readonly rootOperationName: string
	readonly span: TraceSpanItem
}

export interface LogItem {
	readonly id: string
	readonly timestamp: Date
	readonly serviceName: string
	readonly severityText: string
	readonly body: string
	readonly traceId: string | null
	readonly spanId: string | null
	readonly scopeName: string | null
	readonly attributes: Readonly<Record<string, string>>
}
