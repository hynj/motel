export type TraceSpanStatus = "ok" | "error"

export interface TraceSpanItem {
	readonly spanId: string
	readonly parentSpanId: string | null
	readonly serviceName: string
	readonly operationName: string
	readonly startTime: Date
	readonly durationMs: number
	readonly status: TraceSpanStatus
	readonly depth: number
	readonly tags: Readonly<Record<string, string>>
	readonly warnings: readonly string[]
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
