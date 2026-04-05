import { Effect } from "effect"
import { config, parsePositiveInt, resolveOtelUrl } from "./config.js"
import { letoOpenApiSpec } from "./httpApi.js"
import { storeRuntime } from "./runtime.js"
import { TelemetryStore } from "./services/TelemetryStore.js"
import type { LogItem, TraceItem, TraceSummaryItem } from "./domain.js"

const TRACE_DEFAULT_LIMIT = 20
const TRACE_MAX_LIMIT = 100
const TRACE_DEFAULT_LOOKBACK = 60
const TRACE_MAX_LOOKBACK = 24 * 60
const LOG_DEFAULT_LIMIT = 100
const LOG_MAX_LIMIT = 500
const LOG_DEFAULT_LOOKBACK = 60
const LOG_MAX_LOOKBACK = 24 * 60

let server: ReturnType<typeof Bun.serve> | null = null

const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	})

const text = (value: string, status = 200, contentType = "text/plain; charset=utf-8") =>
	new Response(value, { status, headers: { "content-type": contentType, "cache-control": "no-store" } })

const notFound = () => json({ error: "Not found" }, 404)

const buildStoreEffect = <A>(fn: (store: TelemetryStore["Service"]) => Effect.Effect<A, Error>) => Effect.flatMap(TelemetryStore.asEffect(), fn)

const parseLimit = (value: string | null, fallback: number) => parsePositiveInt(value ?? undefined, fallback)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))
const parseBoundedLimit = (value: string | null, fallback: number, max: number) => clamp(parseLimit(value, fallback), 1, max)

const parseLookbackMinutes = (value: string | null, fallback: number) => {
	if (!value) return fallback
	const match = value.trim().match(/^(\d+)([mhd])$/i)
	if (!match) return fallback
	const amount = Number.parseInt(match[1] ?? "", 10)
	if (!Number.isFinite(amount) || amount <= 0) return fallback
	const unit = (match[2] ?? "m").toLowerCase()
	if (unit === "d") return amount * 1440
	if (unit === "h") return amount * 60
	return amount
}

const parseBoundedLookbackMinutes = (value: string | null, fallback: number, max: number) => clamp(parseLookbackMinutes(value, fallback), 1, max)

const attributeFiltersFromQuery = (url: URL) =>
	Object.fromEntries(
		[...url.searchParams.entries()]
			.filter(([key]) => key.startsWith("attr."))
			.map(([key, value]) => [key.slice("attr.".length), value]),
	)

type CursorShape =
	| { readonly kind: "trace"; readonly startedAt: number; readonly id: string }
	| { readonly kind: "log"; readonly timestamp: number; readonly id: string }

const encodeCursor = (cursor: CursorShape) => Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")

const decodeCursor = (value: string | null): CursorShape | null => {
	if (!value) return null
	try {
		return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorShape
	} catch {
		return null
	}
}

const formatLookback = (minutes: number) => {
	if (minutes % 1440 === 0) return `${minutes / 1440}d`
	if (minutes % 60 === 0) return `${minutes / 60}h`
	return `${minutes}m`
}

const traceSummary = (trace: TraceItem): TraceSummaryItem => ({
	traceId: trace.traceId,
	serviceName: trace.serviceName,
	rootOperationName: trace.rootOperationName,
	startedAt: trace.startedAt,
	durationMs: trace.durationMs,
	spanCount: trace.spanCount,
	errorCount: trace.errorCount,
	warnings: trace.warnings,
})

const applyTraceCursor = (traces: readonly TraceItem[], cursor: CursorShape | null) => {
	if (!cursor || cursor.kind !== "trace") return traces
	return traces.filter((trace) => {
		const startedAt = trace.startedAt.getTime()
		if (startedAt < cursor.startedAt) return true
		if (startedAt > cursor.startedAt) return false
		return trace.traceId < cursor.id
	})
}

const applyLogCursor = (logs: readonly LogItem[], cursor: CursorShape | null) => {
	if (!cursor || cursor.kind !== "log") return logs
	return logs.filter((log) => {
		const timestamp = log.timestamp.getTime()
		if (timestamp < cursor.timestamp) return true
		if (timestamp > cursor.timestamp) return false
		return log.id < cursor.id
	})
}

const listMeta = (input: { readonly limit: number; readonly lookbackMinutes: number; readonly returned: number; readonly truncated: boolean; readonly nextCursor: string | null }) => ({
	limit: input.limit,
	lookback: formatLookback(input.lookbackMinutes),
	returned: input.returned,
	truncated: input.truncated,
	nextCursor: input.nextCursor,
})

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")

const renderTracePage = (trace: TraceItem, logs: readonly LogItem[]) => {
	const logCountsBySpan = new Map<string, number>()
	for (const log of logs) {
		if (!log.spanId) continue
		logCountsBySpan.set(log.spanId, (logCountsBySpan.get(log.spanId) ?? 0) + 1)
	}

	const spansHtml = trace.spans
		.map((span) => {
			const indent = Math.min(span.depth * 20, 120)
			const count = logCountsBySpan.get(span.spanId) ?? 0
			return `<tr>
<td style="padding-left:${indent}px">${escapeHtml(span.operationName)}</td>
<td>${escapeHtml(span.serviceName)}</td>
<td>${escapeHtml(span.status)}</td>
<td>${span.durationMs.toFixed(2)}ms</td>
<td>${count}</td>
</tr>`
		})
		.join("\n")

	const logsHtml = logs
		.slice(0, 80)
		.map(
			(log) => `<tr>
<td>${escapeHtml(log.timestamp.toISOString())}</td>
<td>${escapeHtml(log.severityText)}</td>
<td>${escapeHtml(log.scopeName ?? log.serviceName)}</td>
<td><pre>${escapeHtml(log.body)}</pre></td>
</tr>`,
		)
		.join("\n")

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(trace.rootOperationName)}</title>
<style>
body { background:#0b0b0b; color:#ede7da; font-family: ui-monospace, SFMono-Regular, monospace; margin:24px; }
h1,h2 { color:#f4a51c; }
.muted { color:#9f9788; }
table { width:100%; border-collapse: collapse; margin-top:16px; }
th, td { border-bottom:1px solid #2a2520; padding:8px; text-align:left; vertical-align:top; }
pre { white-space:pre-wrap; margin:0; color:#ede7da; }
</style>
</head>
<body>
<h1>${escapeHtml(trace.rootOperationName)}</h1>
<p class="muted">${escapeHtml(trace.serviceName)} · ${trace.durationMs.toFixed(2)}ms · ${trace.spanCount} spans · ${logs.length} logs</p>
<p class="muted">${escapeHtml(trace.traceId)}</p>
<h2>Spans</h2>
<table>
<thead><tr><th>Operation</th><th>Service</th><th>Status</th><th>Duration</th><th>Logs</th></tr></thead>
<tbody>${spansHtml}</tbody>
</table>
<h2>Logs</h2>
<table>
<thead><tr><th>Time</th><th>Level</th><th>Scope</th><th>Body</th></tr></thead>
<tbody>${logsHtml}</tbody>
</table>
</body>
</html>`
}

const handleRequest = async (request: Request) => {
	const url = new URL(request.url)
	const path = url.pathname

	try {
		if (request.method === "GET" && path === "/") {
			return text(`leto local telemetry server\n\nPOST /v1/traces\nPOST /v1/logs\nGET /api/services\nGET /api/traces\nGET /api/traces/search\nGET /api/traces/stats\nGET /api/traces/<trace-id>\nGET /api/traces/<trace-id>/logs\nGET /api/spans/<span-id>\nGET /api/logs\nGET /api/logs/search\nGET /api/logs/stats\nGET /api/facets?type=logs&field=severity\nGET /openapi.json\nGET /docs\nGET /trace/<trace-id>\n`)
		}

		if (request.method === "GET" && path === "/openapi.json") {
			return json(letoOpenApiSpec)
		}

		if (request.method === "GET" && path === "/docs") {
			return text(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>leto API docs</title>
<script id="api-reference" data-url="/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</head>
<body></body>
</html>`, 200, "text/html; charset=utf-8")
		}

		if (request.method === "GET" && path === "/api/health") {
			return json({ ok: true, service: "leto-local-server", databasePath: config.otel.databasePath })
		}

		if (request.method === "POST" && path === "/v1/traces") {
			const payload = await request.json()
			const result = await storeRuntime.runPromise(buildStoreEffect((store) => store.ingestTraces(payload)))
			return json(result)
		}

		if (request.method === "POST" && path === "/v1/logs") {
			const payload = await request.json()
			const result = await storeRuntime.runPromise(buildStoreEffect((store) => store.ingestLogs(payload)))
			return json(result)
		}

		if (request.method === "GET" && path === "/api/services") {
			const data = await storeRuntime.runPromise(buildStoreEffect((store) => store.listServices))
			return json({ data })
		}

		if (request.method === "GET" && path === "/api/traces") {
			const service = url.searchParams.get("service")
			const limit = parseBoundedLimit(url.searchParams.get("limit"), TRACE_DEFAULT_LIMIT, TRACE_MAX_LIMIT)
			const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
			const cursor = decodeCursor(url.searchParams.get("cursor"))
			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.listRecentTraces(service, {
						limit: TRACE_MAX_LIMIT + 1,
						lookbackMinutes,
					}),
				),
			)
			const scoped = applyTraceCursor(data, cursor)
			const page = scoped.slice(0, limit)
			const last = page.at(-1)
			return json({
				data: page.map(traceSummary),
				meta: listMeta({
					limit,
					lookbackMinutes,
					returned: page.length,
					truncated: scoped.length > page.length,
					nextCursor: last ? encodeCursor({ kind: "trace", startedAt: last.startedAt.getTime(), id: last.traceId }) : null,
				}),
			})
		}

		if (request.method === "GET" && path === "/api/traces/search") {
			const attributeFilters = attributeFiltersFromQuery(url)
			const limit = parseBoundedLimit(url.searchParams.get("limit"), TRACE_DEFAULT_LIMIT, TRACE_MAX_LIMIT)
			const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), TRACE_DEFAULT_LOOKBACK, TRACE_MAX_LOOKBACK)
			const cursor = decodeCursor(url.searchParams.get("cursor"))
			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.searchTraces({
						serviceName: url.searchParams.get("service"),
						operation: url.searchParams.get("operation"),
						status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
						minDurationMs: url.searchParams.get("minDurationMs") ? Number.parseFloat(url.searchParams.get("minDurationMs") ?? "") : null,
						attributeFilters,
						limit: TRACE_MAX_LIMIT + 1,
						lookbackMinutes,
					}),
				),
			)
			const scoped = applyTraceCursor(data, cursor)
			const page = scoped.slice(0, limit)
			const last = page.at(-1)
			return json({
				data: page.map(traceSummary),
				meta: listMeta({
					limit,
					lookbackMinutes,
					returned: page.length,
					truncated: scoped.length > page.length,
					nextCursor: last ? encodeCursor({ kind: "trace", startedAt: last.startedAt.getTime(), id: last.traceId }) : null,
				}),
			})
		}

		if (request.method === "GET" && path === "/api/traces/stats") {
			const attributeFilters = attributeFiltersFromQuery(url)
			const groupBy = url.searchParams.get("groupBy")
			const agg = url.searchParams.get("agg")
			if (!groupBy || (agg !== "count" && agg !== "avg_duration" && agg !== "p95_duration" && agg !== "error_rate")) {
				return json({ error: "Expected groupBy and agg=count|avg_duration|p95_duration|error_rate" }, 400)
			}

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.traceStats({
						groupBy,
						agg,
						serviceName: url.searchParams.get("service"),
						operation: url.searchParams.get("operation"),
						status: (url.searchParams.get("status") as "ok" | "error" | null) ?? null,
						minDurationMs: url.searchParams.get("minDurationMs") ? Number.parseFloat(url.searchParams.get("minDurationMs") ?? "") : null,
						attributeFilters,
						limit: parseLimit(url.searchParams.get("limit"), 20),
						lookbackMinutes: parseLookbackMinutes(url.searchParams.get("lookback"), config.otel.traceLookbackMinutes),
					}),
				),
			)
			return json({ data })
		}

		if (request.method === "GET" && path.startsWith("/api/traces/") && path.endsWith("/logs")) {
			const traceId = decodeURIComponent(path.slice("/api/traces/".length, -"/logs".length))
			const data = await storeRuntime.runPromise(buildStoreEffect((store) => store.listTraceLogs(traceId)))
			return json({ data })
		}

		if (request.method === "GET" && path.startsWith("/api/spans/")) {
			const spanId = decodeURIComponent(path.slice("/api/spans/".length))
			const data = await storeRuntime.runPromise(buildStoreEffect((store) => store.getSpan(spanId)))
			return data ? json({ data }) : json({ error: "Span not found" }, 404)
		}

		if (request.method === "GET" && path.startsWith("/api/traces/")) {
			const traceId = decodeURIComponent(path.slice("/api/traces/".length))
			const data = await storeRuntime.runPromise(buildStoreEffect((store) => store.getTrace(traceId)))
			return data ? json({ data }) : json({ error: "Trace not found" }, 404)
		}

		if (request.method === "GET" && path === "/api/logs") {
		 	const attributeFilters = attributeFiltersFromQuery(url)
			const limit = parseBoundedLimit(url.searchParams.get("limit"), LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT)
			const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), LOG_DEFAULT_LOOKBACK, LOG_MAX_LOOKBACK)
			const cursor = decodeCursor(url.searchParams.get("cursor"))

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.searchLogs({
						serviceName: url.searchParams.get("service"),
						traceId: url.searchParams.get("traceId"),
						spanId: url.searchParams.get("spanId"),
						body: url.searchParams.get("body"),
						limit: LOG_MAX_LIMIT + 1,
						attributeFilters,
					}),
				),
			)

			const filteredByLookback = data.filter((log) => Date.now() - log.timestamp.getTime() <= lookbackMinutes * 60_000)
			const scoped = applyLogCursor(filteredByLookback, cursor)
			const page = scoped.slice(0, limit)
			const last = page.at(-1)
			return json({
				data: page,
				meta: listMeta({
					limit,
					lookbackMinutes,
					returned: page.length,
					truncated: scoped.length > page.length,
					nextCursor: last ? encodeCursor({ kind: "log", timestamp: last.timestamp.getTime(), id: last.id }) : null,
				}),
			})
		}

		if (request.method === "GET" && path === "/api/logs/search") {
			const attributeFilters = attributeFiltersFromQuery(url)
			const limit = parseBoundedLimit(url.searchParams.get("limit"), LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT)
			const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), LOG_DEFAULT_LOOKBACK, LOG_MAX_LOOKBACK)
			const cursor = decodeCursor(url.searchParams.get("cursor"))

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.searchLogs({
						serviceName: url.searchParams.get("service"),
						traceId: url.searchParams.get("traceId"),
						spanId: url.searchParams.get("spanId"),
						body: url.searchParams.get("body"),
						limit: LOG_MAX_LIMIT + 1,
						attributeFilters,
					}),
				),
			)

			const filteredByLookback = data.filter((log) => Date.now() - log.timestamp.getTime() <= lookbackMinutes * 60_000)
			const scoped = applyLogCursor(filteredByLookback, cursor)
			const page = scoped.slice(0, limit)
			const last = page.at(-1)

			return json({
				data: page,
				meta: listMeta({
					limit,
					lookbackMinutes,
					returned: page.length,
					truncated: scoped.length > page.length,
					nextCursor: last ? encodeCursor({ kind: "log", timestamp: last.timestamp.getTime(), id: last.id }) : null,
				}),
			})
		}

		if (request.method === "GET" && path === "/api/logs/search") {
			const attributeFilters = attributeFiltersFromQuery(url)
			const limit = parseBoundedLimit(url.searchParams.get("limit"), LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT)
			const lookbackMinutes = parseBoundedLookbackMinutes(url.searchParams.get("lookback"), LOG_DEFAULT_LOOKBACK, LOG_MAX_LOOKBACK)
			const cursor = decodeCursor(url.searchParams.get("cursor"))

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.searchLogs({
						serviceName: url.searchParams.get("service"),
						traceId: url.searchParams.get("traceId"),
						spanId: url.searchParams.get("spanId"),
						body: url.searchParams.get("body"),
						limit: LOG_MAX_LIMIT + 1,
						attributeFilters,
					}),
				),
			)

			const filteredByLookback = data.filter((log) => Date.now() - log.timestamp.getTime() <= lookbackMinutes * 60_000)
			const scoped = applyLogCursor(filteredByLookback, cursor)
			const page = scoped.slice(0, limit)
			const last = page.at(-1)

			return json({
				data: page,
				meta: listMeta({
					limit,
					lookbackMinutes,
					returned: page.length,
					truncated: scoped.length > page.length,
					nextCursor: last ? encodeCursor({ kind: "log", timestamp: last.timestamp.getTime(), id: last.id }) : null,
				}),
			})
		}

		if (request.method === "GET" && path === "/api/logs/stats") {
			const attributeFilters = attributeFiltersFromQuery(url)
			const groupBy = url.searchParams.get("groupBy")
			const agg = url.searchParams.get("agg")
			if (!groupBy || agg !== "count") {
				return json({ error: "Expected groupBy and agg=count" }, 400)
			}

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.logStats({
						groupBy,
						agg: "count",
						serviceName: url.searchParams.get("service"),
						traceId: url.searchParams.get("traceId"),
						spanId: url.searchParams.get("spanId"),
						body: url.searchParams.get("body"),
						attributeFilters,
						limit: parseBoundedLimit(url.searchParams.get("limit"), 20, LOG_MAX_LIMIT),
					}),
				),
			)
			return json({ data })
		}

		if (request.method === "GET" && path === "/api/facets") {
			const type = url.searchParams.get("type")
			const field = url.searchParams.get("field")
			if ((type !== "traces" && type !== "logs") || !field) {
				return json({ error: "Expected type=traces|logs and field=<name>" }, 400)
			}

			const data = await storeRuntime.runPromise(
				buildStoreEffect((store) =>
					store.listFacets({
						type,
						field,
						serviceName: url.searchParams.get("service"),
						lookbackMinutes: parseLookbackMinutes(url.searchParams.get("lookback"), config.otel.traceLookbackMinutes),
						limit: parseLimit(url.searchParams.get("limit"), 20),
					}),
				),
			)

			return json({ data })
		}

		if (request.method === "GET" && path.startsWith("/trace/")) {
			const traceId = decodeURIComponent(path.slice("/trace/".length))
			const trace = await storeRuntime.runPromise(buildStoreEffect((store) => store.getTrace(traceId)))
			if (!trace) return notFound()
			const logs = await storeRuntime.runPromise(buildStoreEffect((store) => store.listTraceLogs(traceId)))
			return text(renderTracePage(trace, logs), 200, "text/html; charset=utf-8")
		}

		return notFound()
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : String(error) }, 500)
	}
}

export const startLocalServer = async () => {
	if (server) return server
	server = Bun.serve({
		hostname: config.otel.host,
		port: config.otel.port,
		fetch: handleRequest,
	})
	return server
}

export const ensureLocalServer = async () => {
	if (server) return server
	try {
		const response = await fetch(resolveOtelUrl("/api/health"), { signal: AbortSignal.timeout(250) })
		if (response.ok) return null
	} catch {
		// Start local server below.
	}
	return await startLocalServer()
}
