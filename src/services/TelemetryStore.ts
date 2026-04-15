import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Clock, Effect, Layer, Schedule, ServiceMap } from "effect"
import { config } from "../config.js"
import type { LogItem, SpanItem, TraceItem, TraceSummaryItem, TraceSpanEvent, TraceSpanItem } from "../domain.js"
import { attributeMap, nanosToMilliseconds, parseAnyValue, spanKindLabel, spanStatusLabel, stringifyValue, type OtlpLogExportRequest, type OtlpTraceExportRequest } from "../otlp.js"

interface SpanRow {
	readonly trace_id: string
	readonly span_id: string
	readonly parent_span_id: string | null
	readonly service_name: string
	readonly scope_name: string | null
	readonly operation_name: string
	readonly kind: string | null
	readonly start_time_ms: number
	readonly end_time_ms: number
	readonly duration_ms: number
	readonly status: string
	readonly attributes_json: string
	readonly resource_json: string
	readonly events_json: string
}

interface LogRow {
	readonly id: number
	readonly trace_id: string | null
	readonly span_id: string | null
	readonly service_name: string
	readonly scope_name: string | null
	readonly severity_text: string
	readonly timestamp_ms: number
	readonly body: string
	readonly attributes_json: string
	readonly resource_json: string
}

interface LogSearch {
	readonly serviceName?: string | null
	readonly severity?: string | null
	readonly traceId?: string | null
	readonly spanId?: string | null
	readonly body?: string | null
	readonly lookbackMinutes?: number
	readonly limit?: number
	readonly attributeFilters?: Readonly<Record<string, string>>
}

interface TraceSearch {
	readonly serviceName?: string | null
	readonly operation?: string | null
	readonly status?: "ok" | "error" | null
	readonly minDurationMs?: number | null
	readonly attributeFilters?: Readonly<Record<string, string>>
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface SpanSearch {
	readonly serviceName?: string | null
	readonly operation?: string | null
	readonly parentOperation?: string | null
	readonly status?: "ok" | "error" | null
	readonly lookbackMinutes?: number
	readonly limit?: number
	readonly attributeFilters?: Readonly<Record<string, string>>
}

interface TraceStatsSearch extends TraceSearch {
	readonly groupBy: string
	readonly agg: "count" | "avg_duration" | "p95_duration" | "error_rate"
	readonly limit?: number
}

interface LogStatsSearch extends LogSearch {
	readonly groupBy: string
	readonly agg: "count"
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface FacetItem {
	readonly value: string
	readonly count: number
}

interface StatsItem {
	readonly group: string
	readonly value: number
	readonly count: number
}

interface FacetSearch {
	readonly type: "traces" | "logs"
	readonly field: string
	readonly serviceName?: string | null
	readonly lookbackMinutes?: number
	readonly limit?: number
}

interface TraceSummaryRow {
	readonly trace_id: string
	readonly service_name: string
	readonly root_operation_name: string
	readonly started_at_ms: number
	readonly duration_ms: number
	readonly span_count: number
	readonly error_count: number
}

const parseSummaryRow = (row: TraceSummaryRow): TraceSummaryItem => ({
	traceId: row.trace_id,
	serviceName: row.service_name ?? "unknown",
	rootOperationName: row.root_operation_name ?? "unknown",
	startedAt: new Date(row.started_at_ms),
	durationMs: Math.max(0, row.duration_ms),
	spanCount: row.span_count,
	errorCount: row.error_count,
	warnings: [],
})

const TRACE_SUMMARY_SQL = `
	SELECT
		trace_id,
		COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN service_name END), MIN(service_name)) AS service_name,
		COALESCE(MIN(CASE WHEN parent_span_id IS NULL THEN operation_name END), MIN(operation_name)) AS root_operation_name,
		MIN(start_time_ms) AS started_at_ms,
		MAX(end_time_ms) - MIN(start_time_ms) AS duration_ms,
		COUNT(*) AS span_count,
		SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
	FROM spans
`

const parseRecord = (value: string): Record<string, string> => {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>
		return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, stringifyValue(entry)]))
	} catch {
		return {}
	}
}

const parseEvents = (value: string): readonly TraceSpanEvent[] => {
	try {
		const parsed = JSON.parse(value) as Array<{ name: string; timestamp: number; attributes: Record<string, string> }>
		return parsed.map((event) => ({
			name: event.name,
			timestamp: new Date(event.timestamp),
			attributes: event.attributes,
		}))
	} catch {
		return []
	}
}

const parseSpanRow = (row: SpanRow): TraceSpanItem => ({
	spanId: row.span_id,
	parentSpanId: row.parent_span_id,
	serviceName: row.service_name,
	scopeName: row.scope_name,
	kind: row.kind,
	operationName: row.operation_name,
	startTime: new Date(row.start_time_ms),
	durationMs: row.duration_ms,
	status: row.status === "error" ? "error" : "ok",
	depth: 0,
	tags: {
		...parseRecord(row.resource_json),
		...parseRecord(row.attributes_json),
	},
	warnings: [],
	events: parseEvents(row.events_json),
})

const parseLogRow = (row: LogRow): LogItem => ({
	id: String(row.id),
	timestamp: new Date(row.timestamp_ms),
	serviceName: row.service_name,
	severityText: row.severity_text,
	body: row.body,
	traceId: row.trace_id,
	spanId: row.span_id,
	scopeName: row.scope_name,
	attributes: {
		...parseRecord(row.resource_json),
		...parseRecord(row.attributes_json),
	},
})

const orderTraceSpans = (spans: readonly TraceSpanItem[]) => {
	const childrenByParent = new Map<string | null, TraceSpanItem[]>()
	const spanIds = new Set(spans.map((span) => span.spanId))

	for (const span of spans) {
		const key = span.parentSpanId && spanIds.has(span.parentSpanId) ? span.parentSpanId : null
		const siblings = childrenByParent.get(key) ?? []
		siblings.push(span)
		childrenByParent.set(key, siblings)
	}

	for (const siblings of childrenByParent.values()) {
		siblings.sort((left, right) => left.startTime.getTime() - right.startTime.getTime())
	}

	const ordered: Array<TraceSpanItem> = []
	const visit = (parent: string | null, depth: number) => {
		for (const child of childrenByParent.get(parent) ?? []) {
			ordered.push({ ...child, depth })
			visit(child.spanId, depth + 1)
		}
	}

	visit(null, 0)
	return ordered
}

const buildTrace = (traceId: string, spanRows: readonly SpanRow[]): TraceItem => {
	const parsedSpans = spanRows.map(parseSpanRow)
	const orderedSpans = orderTraceSpans(parsedSpans)
	const startedAtMs = Math.min(...orderedSpans.map((span) => span.startTime.getTime()))
	const endedAtMs = Math.max(...orderedSpans.map((span) => span.startTime.getTime() + span.durationMs))
	const rootSpan = orderedSpans[0] ?? null
	const spanIds = new Set(orderedSpans.map((span) => span.spanId))
	const warnings = orderedSpans
		.filter((span) => span.parentSpanId !== null && !spanIds.has(span.parentSpanId))
		.map((span) => `missing parent ${span.parentSpanId} for ${span.operationName}`)

	return {
		traceId,
		serviceName: rootSpan?.serviceName ?? "unknown",
		rootOperationName: rootSpan?.operationName ?? "unknown",
		startedAt: new Date(startedAtMs),
		durationMs: Math.max(0, endedAtMs - startedAtMs),
		spanCount: orderedSpans.length,
		errorCount: orderedSpans.filter((span) => span.status === "error").length,
		warnings,
		spans: orderedSpans,
	}
}

const buildSpanItems = (traceId: string, spanRows: readonly SpanRow[]): readonly SpanItem[] => {
	const trace = buildTrace(traceId, spanRows)
	const spanById = new Map(trace.spans.map((span) => [span.spanId, span]))
	return trace.spans.map((span) => ({
		traceId,
		rootOperationName: trace.rootOperationName,
		parentOperationName: span.parentSpanId ? spanById.get(span.parentSpanId)?.operationName ?? null : null,
		span,
	}))
}

const buildSpanItem = (traceId: string, spanRows: readonly SpanRow[], spanId: string): SpanItem | null =>
	buildSpanItems(traceId, spanRows).find((item) => item.span.spanId === spanId) ?? null

const matchesAttributes = (attributes: Readonly<Record<string, string>>, filters: Readonly<Record<string, string>> | undefined) =>
	!filters || Object.entries(filters).every(([key, value]) => attributes[key] === value)

const percentile = (values: readonly number[], ratio: number) => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((left, right) => left - right)
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
	return sorted[index] ?? 0
}

export class TelemetryStore extends ServiceMap.Service<
	TelemetryStore,
	{
		readonly ingestTraces: (payload: OtlpTraceExportRequest) => Effect.Effect<{ readonly insertedSpans: number }, Error>
		readonly ingestLogs: (payload: OtlpLogExportRequest) => Effect.Effect<{ readonly insertedLogs: number }, Error>
		readonly listServices: Effect.Effect<readonly string[], Error>
		readonly listRecentTraces: (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) => Effect.Effect<readonly TraceItem[], Error>
		readonly listTraceSummaries: (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) => Effect.Effect<readonly TraceSummaryItem[], Error>
		readonly searchTraces: (input: TraceSearch) => Effect.Effect<readonly TraceItem[], Error>
		readonly searchTraceSummaries: (input: TraceSearch) => Effect.Effect<readonly TraceSummaryItem[], Error>
		readonly traceStats: (input: TraceStatsSearch) => Effect.Effect<readonly StatsItem[], Error>
		readonly getTrace: (traceId: string) => Effect.Effect<TraceItem | null, Error>
		readonly getSpan: (spanId: string) => Effect.Effect<SpanItem | null, Error>
		readonly listTraceSpans: (traceId: string) => Effect.Effect<readonly SpanItem[], Error>
		readonly searchSpans: (input: SpanSearch) => Effect.Effect<readonly SpanItem[], Error>
		readonly searchLogs: (input: LogSearch) => Effect.Effect<readonly LogItem[], Error>
		readonly logStats: (input: LogStatsSearch) => Effect.Effect<readonly StatsItem[], Error>
		readonly listFacets: (input: FacetSearch) => Effect.Effect<readonly FacetItem[], Error>
		readonly listRecentLogs: (serviceName: string) => Effect.Effect<readonly LogItem[], Error>
		readonly listTraceLogs: (traceId: string) => Effect.Effect<readonly LogItem[], Error>
	}
>()("motel/TelemetryStore") {}


export const TelemetryStoreLive = Layer.effect(
	TelemetryStore,
	Effect.gen(function* () {
		mkdirSync(dirname(config.otel.databasePath), { recursive: true })
		const db = yield* Effect.acquireRelease(
			Effect.sync(() => new Database(config.otel.databasePath, { create: true })),
			(db) => Effect.sync(() => db.close()),
		)
		db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			PRAGMA temp_store = MEMORY;
			PRAGMA busy_timeout = 5000;

			CREATE TABLE IF NOT EXISTS spans (
				trace_id TEXT NOT NULL,
				span_id TEXT NOT NULL,
				parent_span_id TEXT,
				service_name TEXT NOT NULL,
				scope_name TEXT,
				operation_name TEXT NOT NULL,
				kind TEXT,
				start_time_ms INTEGER NOT NULL,
				end_time_ms INTEGER NOT NULL,
				duration_ms REAL NOT NULL,
				status TEXT NOT NULL,
				attributes_json TEXT NOT NULL,
				resource_json TEXT NOT NULL,
				events_json TEXT NOT NULL,
				PRIMARY KEY (trace_id, span_id)
			);

			CREATE INDEX IF NOT EXISTS idx_spans_service_time ON spans(service_name, start_time_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_spans_trace_time ON spans(trace_id, start_time_ms ASC);
			CREATE INDEX IF NOT EXISTS idx_spans_span_id ON spans(span_id);

			CREATE TABLE IF NOT EXISTS logs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				trace_id TEXT,
				span_id TEXT,
				service_name TEXT NOT NULL,
				scope_name TEXT,
				severity_text TEXT NOT NULL,
				timestamp_ms INTEGER NOT NULL,
				body TEXT NOT NULL,
				attributes_json TEXT NOT NULL,
				resource_json TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_logs_service_time ON logs(service_name, timestamp_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_logs_trace_time ON logs(trace_id, timestamp_ms DESC);
			CREATE INDEX IF NOT EXISTS idx_logs_span_time ON logs(span_id, timestamp_ms DESC);
		`)

		const insertSpan = db.query(`
			INSERT INTO spans (
				trace_id, span_id, parent_span_id, service_name, scope_name, operation_name, kind,
				start_time_ms, end_time_ms, duration_ms, status, attributes_json, resource_json, events_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(trace_id, span_id) DO UPDATE SET
				parent_span_id = excluded.parent_span_id,
				service_name = excluded.service_name,
				scope_name = excluded.scope_name,
				operation_name = excluded.operation_name,
				kind = excluded.kind,
				start_time_ms = excluded.start_time_ms,
				end_time_ms = excluded.end_time_ms,
				duration_ms = excluded.duration_ms,
				status = excluded.status,
				attributes_json = excluded.attributes_json,
				resource_json = excluded.resource_json,
				events_json = excluded.events_json
		`)

		const insertLog = db.query(`
			INSERT INTO logs (
				trace_id, span_id, service_name, scope_name, severity_text, timestamp_ms, body, attributes_json, resource_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`)

		const maxDbSizeBytes = config.otel.maxDbSizeMb * 1024 * 1024

		const cleanupExpired = Effect.fn("motel/TelemetryStore.cleanupExpired")(function* () {
			const now = yield* Clock.currentTimeMillis

			yield* Effect.sync(() => {
				// Time-based retention
				const cutoff = now - config.otel.retentionHours * 60 * 60 * 1000
				db.query(`DELETE FROM spans WHERE start_time_ms < ?`).run(cutoff)
				db.query(`DELETE FROM logs WHERE timestamp_ms < ?`).run(cutoff)

				// Size-based retention: if DB exceeds max, delete oldest 20% of rows
				const pageCount = (db.query(`PRAGMA page_count`).get() as { page_count: number }).page_count
				const pageSize = (db.query(`PRAGMA page_size`).get() as { page_size: number }).page_size
				const dbSize = pageCount * pageSize
				if (dbSize > maxDbSizeBytes) {
					const spanCount = (db.query(`SELECT COUNT(*) AS c FROM spans`).get() as { c: number }).c
					const logCount = (db.query(`SELECT COUNT(*) AS c FROM logs`).get() as { c: number }).c
					const spanCutCount = Math.max(1, Math.floor(spanCount * 0.2))
					const logCutCount = Math.max(1, Math.floor(logCount * 0.2))
					db.query(`DELETE FROM spans WHERE rowid IN (SELECT rowid FROM spans ORDER BY start_time_ms ASC LIMIT ?)`).run(spanCutCount)
					db.query(`DELETE FROM logs WHERE rowid IN (SELECT rowid FROM logs ORDER BY timestamp_ms ASC LIMIT ?)`).run(logCutCount)
				}
			})
		})

		// Run cleanup every 60 seconds in the background, tied to the layer's scope
		yield* Effect.forkScoped(Effect.repeat(cleanupExpired(), Schedule.spaced("60 seconds")))

		const ingestTraces = Effect.fn("motel/TelemetryStore.ingestTraces")(function* (payload: OtlpTraceExportRequest) {


			return yield* Effect.sync(() => {
				let insertedSpans = 0
				const transaction = db.transaction((request: OtlpTraceExportRequest) => {
					for (const resourceSpans of request.resourceSpans ?? []) {
						const resourceAttributes = attributeMap(resourceSpans.resource?.attributes)
						const serviceName = resourceAttributes["service.name"] || resourceAttributes["service_name"] || "unknown"

						for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
							const scopeName = scopeSpans.scope?.name ?? null

							for (const span of scopeSpans.spans ?? []) {
								const startTimeMs = nanosToMilliseconds(span.startTimeUnixNano)
								const endTimeMs = nanosToMilliseconds(span.endTimeUnixNano)
								const events = (span.events ?? []).map((event) => ({
									name: event.name ?? "event",
									timestamp: nanosToMilliseconds(event.timeUnixNano),
									attributes: attributeMap(event.attributes),
								}))

								insertSpan.run(
									span.traceId,
									span.spanId,
									span.parentSpanId ?? null,
									serviceName,
									scopeName,
									span.name ?? "unknown",
									spanKindLabel(span.kind),
									startTimeMs,
									endTimeMs,
									Math.max(0, endTimeMs - startTimeMs),
									spanStatusLabel(span.status?.code),
									JSON.stringify(attributeMap(span.attributes)),
									JSON.stringify(resourceAttributes),
									JSON.stringify(events),
								)
								insertedSpans += 1
							}
						}
					}
				})

				transaction(payload)
				return { insertedSpans }
			})
		})

		const ingestLogs = Effect.fn("motel/TelemetryStore.ingestLogs")(function* (payload: OtlpLogExportRequest) {


			return yield* Effect.sync(() => {
				let insertedLogs = 0
				const transaction = db.transaction((request: OtlpLogExportRequest) => {
					for (const resourceLogs of request.resourceLogs ?? []) {
						const resourceAttributes = attributeMap(resourceLogs.resource?.attributes)
						const serviceName = resourceAttributes["service.name"] || resourceAttributes["service_name"] || "unknown"

						for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
							const scopeName = scopeLogs.scope?.name ?? null

							for (const record of scopeLogs.logRecords ?? []) {
								const attributes = attributeMap(record.attributes)
								const timestampMs = nanosToMilliseconds(record.timeUnixNano ?? record.observedTimeUnixNano)
								insertLog.run(
									attributes.traceId || attributes.trace_id || record.traceId || null,
									attributes.spanId || attributes.span_id || record.spanId || null,
									serviceName,
									scopeName,
									record.severityText ?? "INFO",
									timestampMs,
									stringifyValue(parseAnyValue(record.body)),
									JSON.stringify(attributes),
									JSON.stringify(resourceAttributes),
								)
								insertedLogs += 1
							}
						}
					}
				})

				transaction(payload)
				return { insertedLogs }
			})
		})

		const listServices = Effect.fn("motel/TelemetryStore.listServices")(function* () {

			const cutoff = (yield* Clock.currentTimeMillis) - config.otel.traceLookbackMinutes * 60 * 1000
			return yield* Effect.sync(() => {
				const rows = db.query(`
					SELECT service_name FROM spans WHERE start_time_ms >= ?
					UNION
					SELECT service_name FROM logs WHERE timestamp_ms >= ?
					ORDER BY service_name ASC
				`).all(cutoff, cutoff) as Array<{ service_name: string }>
				return rows.map((row) => row.service_name)
			})
		})()

		const listRecentTraces = Effect.fn("motel/TelemetryStore.listRecentTraces")(function* (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) {

			const cutoff = (yield* Clock.currentTimeMillis) - (options?.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = options?.limit ?? config.otel.traceFetchLimit

			return yield* Effect.sync(() => {
				const traceIdRows = serviceName
					? (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(serviceName, cutoff, limit) as Array<{ trace_id: string }>)
					: (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(cutoff, limit) as Array<{ trace_id: string }>)

				const traceIds = traceIdRows.map((row) => row.trace_id)
				if (traceIds.length === 0) return [] as readonly TraceItem[]

				const placeholders = traceIds.map(() => "?").join(", ")
				const rows = db.query(`
					SELECT * FROM spans
					WHERE trace_id IN (${placeholders})
					ORDER BY start_time_ms ASC
				`).all(...traceIds) as SpanRow[]

				const grouped = new Map<string, SpanRow[]>()
				for (const row of rows) {
					const group = grouped.get(row.trace_id) ?? []
					group.push(row)
					grouped.set(row.trace_id, group)
				}

				return traceIds
					.map((traceId) => grouped.get(traceId))
					.filter((rows): rows is SpanRow[] => rows !== undefined)
					.map((rows) => buildTrace(rows[0]!.trace_id, rows))
			})
		})

		const listTraceSummaries = Effect.fn("motel/TelemetryStore.listTraceSummaries")(function* (serviceName: string | null, options?: { readonly lookbackMinutes?: number; readonly limit?: number }) {
			const cutoff = (yield* Clock.currentTimeMillis) - (options?.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = options?.limit ?? config.otel.traceFetchLimit

			return yield* Effect.sync(() => {
				if (serviceName) {
					return db.query(`
						${TRACE_SUMMARY_SQL}
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY started_at_ms DESC
						LIMIT ?
					`).all(serviceName, cutoff, limit) as TraceSummaryRow[]
				}
				return db.query(`
					${TRACE_SUMMARY_SQL}
					WHERE start_time_ms >= ?
					GROUP BY trace_id
					ORDER BY started_at_ms DESC
					LIMIT ?
				`).all(cutoff, limit) as TraceSummaryRow[]
			}).pipe(Effect.map((rows) => rows.map(parseSummaryRow)))
		})

		const searchTraceSummaries = Effect.fn("motel/TelemetryStore.searchTraceSummaries")(function* (input: TraceSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? config.otel.traceFetchLimit

			const hasAttrFilters = Object.keys(input.attributeFilters ?? {}).length > 0
			const hasOperationFilter = !!input.operation

			// If we only have SQL-pushable filters, do it all in one query
			if (!hasAttrFilters && !hasOperationFilter) {
				return yield* Effect.sync(() => {
					const clauses: string[] = ["start_time_ms >= ?"]
					const params: Array<string | number> = [cutoff]

					if (input.serviceName) {
						clauses.push("service_name = ?")
						params.push(input.serviceName)
					}

					const havingClauses: string[] = []
					if (input.status === "error") havingClauses.push("error_count > 0")
					if (input.status === "ok") havingClauses.push("error_count = 0")
					if (input.minDurationMs != null) havingClauses.push(`duration_ms >= ${Number(input.minDurationMs)}`)

					const having = havingClauses.length > 0 ? `HAVING ${havingClauses.join(" AND ")}` : ""

					return db.query(`
						${TRACE_SUMMARY_SQL}
						WHERE ${clauses.join(" AND ")}
						GROUP BY trace_id
						${having}
						ORDER BY started_at_ms DESC
						LIMIT ?
					`).all(...params, limit) as TraceSummaryRow[]
				}).pipe(Effect.map((rows) => rows.map(parseSummaryRow)))
			}

			// Fall back to the full-load path for attribute/operation filters
			// but only parse what we need for summaries
			const candidateLimit = hasAttrFilters ? Math.max(limit * 20, 500) : Math.max(limit * 10, 200)

			return yield* Effect.sync(() => {
				const traceIdRows = input.serviceName
					? (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(input.serviceName, cutoff, candidateLimit) as Array<{ trace_id: string }>)
					: (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(cutoff, candidateLimit) as Array<{ trace_id: string }>)

				const traceIds = traceIdRows.map((row) => row.trace_id)
				if (traceIds.length === 0) return [] as readonly TraceSummaryItem[]

				const placeholders = traceIds.map(() => "?").join(", ")

				// For operation filter, check if any span in the trace matches
				const matchingTraceIds = input.operation
					? new Set(
						(db.query(`
							SELECT DISTINCT trace_id FROM spans
							WHERE trace_id IN (${placeholders}) AND operation_name LIKE ?
						`).all(...traceIds, `%${input.operation}%`) as Array<{ trace_id: string }>).map((r) => r.trace_id),
					)
					: null

				// For attribute filters, we need to check parsed JSON
				let attrMatchingTraceIds: Set<string> | null = null
				if (hasAttrFilters) {
					const rows = db.query(`
						SELECT trace_id, attributes_json, resource_json FROM spans
						WHERE trace_id IN (${placeholders})
					`).all(...traceIds) as Array<{ trace_id: string; attributes_json: string; resource_json: string }>

					attrMatchingTraceIds = new Set<string>()
					for (const row of rows) {
						if (attrMatchingTraceIds.has(row.trace_id)) continue
						const tags = { ...parseRecord(row.resource_json), ...parseRecord(row.attributes_json) }
						if (matchesAttributes(tags, input.attributeFilters)) {
							attrMatchingTraceIds.add(row.trace_id)
						}
					}
				}

				const filteredTraceIds = traceIds.filter((id) => {
					if (matchingTraceIds && !matchingTraceIds.has(id)) return false
					if (attrMatchingTraceIds && !attrMatchingTraceIds.has(id)) return false
					return true
				})

				if (filteredTraceIds.length === 0) return [] as readonly TraceSummaryItem[]

				const filteredPlaceholders = filteredTraceIds.map(() => "?").join(", ")
				const havingClauses: string[] = []
				if (input.status === "error") havingClauses.push("error_count > 0")
				if (input.status === "ok") havingClauses.push("error_count = 0")
				if (input.minDurationMs != null) havingClauses.push(`duration_ms >= ${Number(input.minDurationMs)}`)
				const having = havingClauses.length > 0 ? `HAVING ${havingClauses.join(" AND ")}` : ""

				const summaryRows = db.query(`
					${TRACE_SUMMARY_SQL}
					WHERE trace_id IN (${filteredPlaceholders})
					GROUP BY trace_id
					${having}
					ORDER BY started_at_ms DESC
					LIMIT ?
				`).all(...filteredTraceIds, limit) as TraceSummaryRow[]

				return summaryRows.map(parseSummaryRow)
			})
		})

		const getTrace = Effect.fn("motel/TelemetryStore.getTrace")(function* (traceId: string) {
			return yield* Effect.sync(() => {
				const rows = db.query(`
					SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC
				`).all(traceId) as SpanRow[]
				return rows.length === 0 ? null : buildTrace(traceId, rows)
			})
		})

		const getSpan = Effect.fn("motel/TelemetryStore.getSpan")(function* (spanId: string) {
			return yield* Effect.sync(() => {
				// Fetch only the target span row (uses idx_spans_span_id)
				const spanRow = db.query(`SELECT * FROM spans WHERE span_id = ? LIMIT 1`).get(spanId) as SpanRow | null
				if (!spanRow) return null

				const traceId = spanRow.trace_id

				// Get root operation name (indexed by trace_id)
				const rootRow = db.query(`
					SELECT operation_name FROM spans
					WHERE trace_id = ? AND parent_span_id IS NULL
					ORDER BY start_time_ms ASC LIMIT 1
				`).get(traceId) as { operation_name: string } | null
				const rootOperationName = rootRow?.operation_name ?? "unknown"

				// Get parent operation name if span has a parent (PK lookup)
				let parentOperationName: string | null = null
				if (spanRow.parent_span_id) {
					const parentRow = db.query(`
						SELECT operation_name FROM spans
						WHERE trace_id = ? AND span_id = ?
					`).get(traceId, spanRow.parent_span_id) as { operation_name: string } | null
					parentOperationName = parentRow?.operation_name ?? null
				}

				// Compute depth by walking up parent chain (typically 3-5 hops)
				let depth = 0
				let currentParentId = spanRow.parent_span_id
				while (currentParentId) {
					const parentRow = db.query(`
						SELECT parent_span_id FROM spans WHERE trace_id = ? AND span_id = ?
					`).get(traceId, currentParentId) as { parent_span_id: string | null } | null
					if (!parentRow) break
					depth++
					currentParentId = parentRow.parent_span_id
				}

				const parsed = parseSpanRow(spanRow)
				return {
					traceId,
					rootOperationName,
					parentOperationName,
					span: { ...parsed, depth },
				} satisfies SpanItem
			})
		})

		const listTraceSpans = Effect.fn("motel/TelemetryStore.listTraceSpans")(function* (traceId: string) {
			return yield* Effect.sync(() => {
				const rows = db.query(`SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time_ms ASC`).all(traceId) as SpanRow[]
				return rows.length === 0 ? [] as readonly SpanItem[] : buildSpanItems(traceId, rows)
			})
		})

		const searchSpans = Effect.fn("motel/TelemetryStore.searchSpans")(function* (input: SpanSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 100
			const candidateLimit = Object.keys(input.attributeFilters ?? {}).length > 0 ? Math.max(limit * 20, 500) : Math.max(limit * 10, 200)

			return yield* Effect.sync(() => {
				const clauses: string[] = ["start_time_ms >= ?"]
				const params: Array<string | number> = [cutoff]

				if (input.serviceName) {
					clauses.push("service_name = ?")
					params.push(input.serviceName)
				}
				if (input.operation) {
					clauses.push("operation_name LIKE ?")
					params.push(`%${input.operation}%`)
				}
				if (input.status) {
					clauses.push("status = ?")
					params.push(input.status)
				}

				const rows = db.query(`
					SELECT trace_id, span_id
					FROM spans
					WHERE ${clauses.join(" AND ")}
					ORDER BY start_time_ms DESC
					LIMIT ?
				`).all(...params, candidateLimit) as Array<{ trace_id: string; span_id: string }>

				const traceIds = [...new Set(rows.map((row) => row.trace_id))]
				if (traceIds.length === 0) return [] as readonly SpanItem[]

				const placeholders = traceIds.map(() => "?").join(", ")
				const spanRows = db.query(`
					SELECT * FROM spans
					WHERE trace_id IN (${placeholders})
					ORDER BY start_time_ms ASC
				`).all(...traceIds) as SpanRow[]

				const grouped = new Map<string, SpanRow[]>()
				for (const row of spanRows) {
					const group = grouped.get(row.trace_id) ?? []
					group.push(row)
					grouped.set(row.trace_id, group)
				}

				const itemById = new Map<string, SpanItem>()
				for (const traceId of traceIds) {
					const traceSpanRows = grouped.get(traceId)
					if (!traceSpanRows) continue
					for (const item of buildSpanItems(traceId, traceSpanRows)) {
						itemById.set(item.span.spanId, item)
					}
				}

				return rows
					.map((row) => itemById.get(row.span_id))
					.filter((item): item is SpanItem => item !== undefined)
					.filter((item) => {
						if (input.parentOperation) {
							const needle = input.parentOperation.toLowerCase()
							if (!item.parentOperationName?.toLowerCase().includes(needle)) return false
						}
						if (input.attributeFilters && !matchesAttributes(item.span.tags, input.attributeFilters)) return false
						return true
					})
					.slice(0, limit)
			})
		})

		const searchTraces = Effect.fn("motel/TelemetryStore.searchTraces")(function* (input: TraceSearch) {

			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? config.otel.traceFetchLimit
			const candidateLimit = Object.keys(input.attributeFilters ?? {}).length > 0 ? Math.max(limit * 20, 500) : Math.max(limit * 10, 200)

			return yield* Effect.sync(() => {
				const traceIdRows = input.serviceName
					? (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE service_name = ? AND start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(input.serviceName, cutoff, candidateLimit) as Array<{ trace_id: string }>)
					: (db.query(`
						SELECT trace_id, MIN(start_time_ms) AS trace_start
						FROM spans
						WHERE start_time_ms >= ?
						GROUP BY trace_id
						ORDER BY trace_start DESC
						LIMIT ?
					`).all(cutoff, candidateLimit) as Array<{ trace_id: string }>)

				const traceIds = traceIdRows.map((row) => row.trace_id)
				if (traceIds.length === 0) return [] as readonly TraceItem[]

				const placeholders = traceIds.map(() => "?").join(", ")
				const rows = db.query(`
					SELECT * FROM spans
					WHERE trace_id IN (${placeholders})
					ORDER BY start_time_ms ASC
				`).all(...traceIds) as SpanRow[]

				const grouped = new Map<string, SpanRow[]>()
				for (const row of rows) {
					const group = grouped.get(row.trace_id) ?? []
					group.push(row)
					grouped.set(row.trace_id, group)
				}

				return traceIds
					.map((traceId) => grouped.get(traceId))
					.filter((group): group is SpanRow[] => group !== undefined)
					.map((group) => buildTrace(group[0]!.trace_id, group))
					.filter((trace) => {
						if (input.status === "error" && trace.errorCount === 0) return false
						if (input.status === "ok" && trace.errorCount > 0) return false
						if (input.minDurationMs !== undefined && input.minDurationMs !== null && trace.durationMs < input.minDurationMs) return false
						if (input.operation) {
							const needle = input.operation.toLowerCase()
							if (!trace.spans.some((span) => span.operationName.toLowerCase().includes(needle))) return false
						}
						if (input.attributeFilters && !trace.spans.some((span) => matchesAttributes(span.tags, input.attributeFilters))) return false
						return true
					})
					.slice(0, limit)
			})
		})

		const searchLogs = Effect.fn("motel/TelemetryStore.searchLogs")(function* (input: LogSearch) {
			const now = yield* Clock.currentTimeMillis
			return yield* Effect.sync(() => {
				const clauses: string[] = []
				const params: Array<string | number> = []

				if (input.serviceName) {
					clauses.push(`service_name = ?`)
					params.push(input.serviceName)
				}
				if (input.severity) {
					clauses.push(`severity_text = ?`)
					params.push(input.severity.toUpperCase())
				}
				if (input.traceId) {
					clauses.push(`trace_id = ?`)
					params.push(input.traceId)
				}
				if (input.spanId) {
					clauses.push(`span_id = ?`)
					params.push(input.spanId)
				}
				if (input.body) {
					clauses.push(`body LIKE ? COLLATE NOCASE`)
					params.push(`%${input.body}%`)
				}
				if (input.lookbackMinutes) {
					const cutoff = now - input.lookbackMinutes * 60 * 1000
					clauses.push(`timestamp_ms >= ?`)
					params.push(cutoff)
				}

				const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
				const limit = input.limit ?? config.otel.logFetchLimit
				const queryLimit = Object.keys(input.attributeFilters ?? {}).length > 0 ? Math.max(limit * 10, 500) : limit
				const rows = db.query(`
					SELECT * FROM logs
					${where}
					ORDER BY timestamp_ms DESC
					LIMIT ?
				`).all(...params, queryLimit) as LogRow[]

				const logs = rows.map(parseLogRow)
				const filtered = Object.entries(input.attributeFilters ?? {}).length === 0
					? logs
					: logs.filter((log) =>
						Object.entries(input.attributeFilters ?? {}).every(([key, value]) => log.attributes[key] === value),
					)

				return filtered.slice(0, limit)
			})
		})

		const traceStats = Effect.fn("motel/TelemetryStore.traceStats")(function* (input: TraceStatsSearch) {
			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 20
			const hasAttrFilters = Object.keys(input.attributeFilters ?? {}).length > 0
			const isAttrGroupBy = input.groupBy.startsWith("attr.")

			// For attr.* groupBy or attr filters, fall back to summary-based aggregation
			if (isAttrGroupBy || hasAttrFilters || input.operation) {
				const summaries = yield* searchTraceSummaries({
					serviceName: input.serviceName,
					operation: input.operation,
					status: input.status,
					minDurationMs: input.minDurationMs,
					attributeFilters: input.attributeFilters,
					lookbackMinutes: input.lookbackMinutes,
					limit: 5000,
				})

				// For attr.* groupBy, we need to check span attributes — but only the groupBy key
				let attrLookup: Map<string, string> | null = null
				if (isAttrGroupBy) {
					const attrKey = input.groupBy.slice(5)
					const traceIds = summaries.map((s) => s.traceId)
					if (traceIds.length > 0) {
						const placeholders = traceIds.map(() => "?").join(", ")
						const rows = db.query(`
							SELECT trace_id, attributes_json, resource_json FROM spans
							WHERE trace_id IN (${placeholders})
						`).all(...traceIds) as Array<{ trace_id: string; attributes_json: string; resource_json: string }>

						attrLookup = new Map()
						for (const row of rows) {
							if (attrLookup.has(row.trace_id)) continue
							const tags = { ...parseRecord(row.resource_json), ...parseRecord(row.attributes_json) }
							if (tags[attrKey] !== undefined) {
								attrLookup.set(row.trace_id, tags[attrKey]!)
							}
						}
					}
				}

				const groups = new Map<string, { durations: number[]; errorTraces: number }>()
				for (const summary of summaries) {
					const group = input.groupBy === "service"
						? summary.serviceName
						: input.groupBy === "operation"
							? summary.rootOperationName
							: input.groupBy === "status"
								? summary.errorCount > 0 ? "error" : "ok"
								: isAttrGroupBy
									? attrLookup?.get(summary.traceId) ?? "unknown"
									: "unknown"

					const bucket = groups.get(group) ?? { durations: [], errorTraces: 0 }
					bucket.durations.push(summary.durationMs)
					if (summary.errorCount > 0) bucket.errorTraces++
					groups.set(group, bucket)
				}

				const rows = [...groups.entries()].map(([group, bucket]) => {
					const count = bucket.durations.length
					const value = input.agg === "count"
						? count
						: input.agg === "avg_duration"
							? bucket.durations.reduce((sum, d) => sum + d, 0) / Math.max(1, count)
							: input.agg === "p95_duration"
								? percentile(bucket.durations, 0.95)
								: bucket.errorTraces / Math.max(1, count)
					return { group, value, count }
				})

				return rows.sort((left, right) => right.value - left.value).slice(0, limit)
			}

			// Pure SQL path for standard groupBy fields without attr filters
			return yield* Effect.sync(() => {
				const whereClauses: string[] = ["start_time_ms >= ?"]
				const whereParams: Array<string | number> = [cutoff]

				if (input.serviceName) {
					whereClauses.push("service_name = ?")
					whereParams.push(input.serviceName)
				}

				// Build a CTE that computes per-trace summaries
				const havingClauses: string[] = []
				if (input.status === "error") havingClauses.push("error_count > 0")
				if (input.status === "ok") havingClauses.push("error_count = 0")
				if (input.minDurationMs != null) havingClauses.push(`duration_ms >= ${Number(input.minDurationMs)}`)
				const having = havingClauses.length > 0 ? `HAVING ${havingClauses.join(" AND ")}` : ""

				const groupExpr = input.groupBy === "service"
					? "service_name"
					: input.groupBy === "operation"
						? "root_operation_name"
						: input.groupBy === "status"
							? "CASE WHEN error_count > 0 THEN 'error' ELSE 'ok' END"
							: "'unknown'"

				const aggExpr = input.agg === "count"
					? "COUNT(*)"
					: input.agg === "avg_duration"
						? "AVG(duration_ms)"
						: input.agg === "p95_duration"
							? "AVG(duration_ms)" // approximate; exact p95 below
							: "CAST(SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1)"

				// For p95, we need the per-trace durations to compute in JS
				if (input.agg === "p95_duration") {
					const rows = db.query(`
						WITH trace_summaries AS (
							${TRACE_SUMMARY_SQL}
							WHERE ${whereClauses.join(" AND ")}
							GROUP BY trace_id
							${having}
						)
						SELECT ${groupExpr} AS grp, duration_ms FROM trace_summaries
					`).all(...whereParams) as Array<{ grp: string; duration_ms: number }>

					const groups = new Map<string, number[]>()
					for (const row of rows) {
						const bucket = groups.get(row.grp) ?? []
						bucket.push(row.duration_ms)
						groups.set(row.grp, bucket)
					}

					return [...groups.entries()]
						.map(([group, durations]) => ({ group, value: percentile(durations, 0.95), count: durations.length }))
						.sort((left, right) => right.value - left.value)
						.slice(0, limit)
				}

				const rows = db.query(`
					WITH trace_summaries AS (
						${TRACE_SUMMARY_SQL}
						WHERE ${whereClauses.join(" AND ")}
						GROUP BY trace_id
						${having}
					)
					SELECT ${groupExpr} AS grp, ${aggExpr} AS value, COUNT(*) AS count
					FROM trace_summaries
					GROUP BY grp
					ORDER BY value DESC
					LIMIT ?
				`).all(...whereParams, limit) as Array<{ grp: string; value: number; count: number }>

				return rows.map((row) => ({ group: row.grp, value: row.value, count: row.count }))
			})
		})

		const logStats = Effect.fn("motel/TelemetryStore.logStats")(function* (input: LogStatsSearch) {
			const now = yield* Clock.currentTimeMillis
			const limit = input.limit ?? 20
			const hasAttrFilters = Object.keys(input.attributeFilters ?? {}).length > 0
			const isAttrGroupBy = input.groupBy.startsWith("attr.")

			// For attr.* groupBy or attr filters, fall back to in-memory grouping
			if (isAttrGroupBy || hasAttrFilters) {
				const logs = yield* searchLogs({
					serviceName: input.serviceName,
					traceId: input.traceId,
					spanId: input.spanId,
					body: input.body,
					lookbackMinutes: input.lookbackMinutes,
					attributeFilters: input.attributeFilters,
					limit: 5000,
				})

				const groups = new Map<string, number>()
				for (const log of logs) {
					const group = input.groupBy === "service"
						? log.serviceName
						: input.groupBy === "severity"
							? log.severityText
							: input.groupBy === "scope"
								? log.scopeName ?? "unknown"
								: isAttrGroupBy
									? log.attributes[input.groupBy.slice(5)] ?? "unknown"
									: "unknown"
					groups.set(group, (groups.get(group) ?? 0) + 1)
				}

				return [...groups.entries()]
					.map(([group, count]) => ({ group, value: count, count }))
					.sort((left, right) => right.value - left.value)
					.slice(0, limit)
			}

			// Pure SQL path for standard groupBy fields
			return yield* Effect.sync(() => {
				const clauses: string[] = []
				const params: Array<string | number> = []

				if (input.serviceName) {
					clauses.push("service_name = ?")
					params.push(input.serviceName)
				}
				if (input.traceId) {
					clauses.push("trace_id = ?")
					params.push(input.traceId)
				}
				if (input.spanId) {
					clauses.push("span_id = ?")
					params.push(input.spanId)
				}
				if (input.body) {
					clauses.push("body LIKE ?")
					params.push(`%${input.body}%`)
				}
				if (input.lookbackMinutes) {
					clauses.push("timestamp_ms >= ?")
					params.push(now - input.lookbackMinutes * 60 * 1000)
				}

				const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""

				const groupExpr = input.groupBy === "service"
					? "service_name"
					: input.groupBy === "severity"
						? "severity_text"
						: input.groupBy === "scope"
							? "COALESCE(scope_name, 'unknown')"
							: "'unknown'"

				const rows = db.query(`
					SELECT ${groupExpr} AS grp, COUNT(*) AS count
					FROM logs
					${where}
					GROUP BY grp
					ORDER BY count DESC
					LIMIT ?
				`).all(...params, limit) as Array<{ grp: string; count: number }>

				return rows.map((row) => ({ group: row.grp, value: row.count, count: row.count }))
			})
		})

		const listRecentLogs = Effect.fn("motel/TelemetryStore.listRecentLogs")(function* (serviceName: string) {
			return yield* searchLogs({ serviceName, limit: config.otel.logFetchLimit })
		})

		const listFacets = Effect.fn("motel/TelemetryStore.listFacets")(function* (input: FacetSearch) {

			const cutoff = (yield* Clock.currentTimeMillis) - (input.lookbackMinutes ?? config.otel.traceLookbackMinutes) * 60 * 1000
			const limit = input.limit ?? 20

			return yield* Effect.sync(() => {
				if (input.type === "logs") {
					if (input.field === "service") {
						const rows = db.query(`
							SELECT service_name AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							GROUP BY service_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(cutoff, limit) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "severity") {
						const rows = db.query(`
							SELECT severity_text AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY severity_text
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "scope") {
						const rows = db.query(`
							SELECT COALESCE(scope_name, 'unknown') AS value, COUNT(*) AS count
							FROM logs
							WHERE timestamp_ms >= ?
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY COALESCE(scope_name, 'unknown')
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
						return rows
					}
				}

				if (input.type === "traces") {
					if (input.field === "service") {
						const rows = db.query(`
							SELECT service_name AS value, COUNT(DISTINCT trace_id) AS count
							FROM spans
							WHERE start_time_ms >= ?
							GROUP BY service_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(cutoff, limit) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "operation") {
						const rows = db.query(`
							SELECT operation_name AS value, COUNT(*) AS count
							FROM spans
							WHERE start_time_ms >= ? AND parent_span_id IS NULL
							${input.serviceName ? "AND service_name = ?" : ""}
							GROUP BY operation_name
							ORDER BY count DESC, value ASC
							LIMIT ?
						`).all(...(input.serviceName ? [cutoff, input.serviceName, limit] : [cutoff, limit])) as Array<{ value: string; count: number }>
						return rows
					}
					if (input.field === "status") {
						const serviceFilter = input.serviceName ? "AND service_name = ?" : ""
						const params = input.serviceName ? [cutoff, input.serviceName] : [cutoff]
						const rows = db.query(`
							SELECT trace_status AS value, COUNT(*) AS count
							FROM (
								SELECT
									trace_id,
									CASE WHEN SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) > 0 THEN 'error' ELSE 'ok' END AS trace_status
								FROM spans
								WHERE start_time_ms >= ? ${serviceFilter}
								GROUP BY trace_id
							)
							GROUP BY trace_status
							ORDER BY count DESC
							LIMIT ?
						`).all(...params, limit) as Array<{ value: string; count: number }>
						return rows
					}
				}

				return [] as FacetItem[]
			})
		})

		const listTraceLogs = Effect.fn("motel/TelemetryStore.listTraceLogs")(function* (traceId: string) {
			return yield* searchLogs({ traceId, limit: config.otel.logFetchLimit })
		})

		return TelemetryStore.of({
			ingestTraces,
			ingestLogs,
			listServices,
			listRecentTraces,
			listTraceSummaries,
			searchTraces,
			searchTraceSummaries,
			traceStats,
			getTrace,
			getSpan,
			listTraceSpans,
			searchSpans,
			searchLogs,
			logStats,
			listFacets,
			listRecentLogs,
			listTraceLogs,
		})
	}),
)
