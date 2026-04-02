import { Clock, Effect, Layer, ServiceMap } from "effect"
import { config } from "../config.js"
import type { TraceItem, TraceSpanItem, TraceSpanStatus } from "../domain.js"

interface JaegerApiResponse<A> {
	readonly data?: A
}

interface JaegerTrace {
	readonly traceID: string
	readonly spans: readonly JaegerSpan[]
	readonly processes: Readonly<Record<string, JaegerProcess>>
	readonly warnings?: readonly string[] | null
}

interface JaegerSpan {
	readonly spanID: string
	readonly operationName: string
	readonly startTime: number
	readonly duration: number
	readonly references?: readonly JaegerSpanReference[]
	readonly processID: string
	readonly tags?: readonly JaegerTag[]
	readonly warnings?: readonly string[] | null
}

interface JaegerSpanReference {
	readonly refType: string
	readonly spanID: string
}

interface JaegerProcess {
	readonly serviceName: string
}

interface JaegerTag {
	readonly key: string
	readonly value: unknown
}

const makeQueryUrl = (path: string, searchParams: Readonly<Record<string, string | number | undefined>> = {}) => {
	const baseUrl = config.otel.queryUrl.endsWith("/") ? config.otel.queryUrl : `${config.otel.queryUrl}/`
	const url = new URL(path.startsWith("/") ? path.slice(1) : path, baseUrl)

	for (const [key, value] of Object.entries(searchParams)) {
		if (value === undefined || value === "") continue
		url.searchParams.set(key, String(value))
	}

	return url
}

const queryJaeger = <A>(path: string, searchParams?: Readonly<Record<string, string | number | undefined>>) =>
	Effect.gen(function* () {
		const url = makeQueryUrl(path, searchParams)
		yield* Effect.annotateCurrentSpan({
			"trace.query.url": url.toString(),
			"trace.query.path": path,
		})

		const response = yield* Effect.tryPromise({
			try: () => fetch(url, { signal: AbortSignal.timeout(5000) }),
			catch: (error) => new Error(`Could not load traces from ${config.otel.queryUrl}: ${String(error)}`),
		}).pipe(Effect.withSpan("leto/TraceQueryService.fetch"))

		yield* Effect.annotateCurrentSpan({
			"trace.query.status": response.status,
			"trace.query.ok": response.ok,
		})

		if (!response.ok) {
			const detail = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: (error) => new Error(`Could not read Jaeger error response: ${String(error)}`),
			}).pipe(Effect.withSpan("leto/TraceQueryService.readErrorBody"))

			return yield* Effect.fail(new Error(`Jaeger query ${response.status}: ${detail.trim() || response.statusText}`))
		}

		return yield* Effect.tryPromise({
			try: () => response.json() as Promise<A>,
			catch: (error) => new Error(`Could not decode Jaeger response: ${String(error)}`),
		}).pipe(Effect.withSpan("leto/TraceQueryService.decodeJson"))
	})

const lookbackWindow = (minutes: number) => {
	if (minutes % 1440 === 0) return `${Math.max(1, Math.floor(minutes / 1440))}d`
	if (minutes % 60 === 0) return `${Math.max(1, Math.floor(minutes / 60))}h`
	return `${minutes}m`
}

const tagMap = (tags: readonly JaegerTag[] | undefined): Record<string, string> =>
	Object.fromEntries((tags ?? []).map((tag) => [tag.key, String(tag.value)]))

const spanStatus = (span: JaegerSpan): TraceSpanStatus => {
	const tags = tagMap(span.tags)
	return tags.error === "true" || tags["otel.status_code"] === "ERROR" ? "error" : "ok"
}

const parentSpanId = (span: JaegerSpan) => span.references?.find((reference) => reference.refType === "CHILD_OF")?.spanID ?? null

const orderSpans = (trace: JaegerTrace) => {
	const childrenByParent = new Map<string | null, JaegerSpan[]>()
	const spanIds = new Set(trace.spans.map((span) => span.spanID))

	for (const span of trace.spans) {
		const parent = parentSpanId(span)
		const key = parent && spanIds.has(parent) ? parent : null
		const siblings = childrenByParent.get(key) ?? []
		siblings.push(span)
		childrenByParent.set(key, siblings)
	}

	for (const siblings of childrenByParent.values()) {
		siblings.sort((left, right) => left.startTime - right.startTime)
	}

	const ordered: Array<{ span: JaegerSpan; depth: number }> = []
	const visit = (parent: string | null, depth: number) => {
		for (const child of childrenByParent.get(parent) ?? []) {
			ordered.push({ span: child, depth })
			visit(child.spanID, depth + 1)
		}
	}

	visit(null, 0)
	return ordered
}

const parseTrace = (requestedServiceName: string, trace: JaegerTrace): TraceItem => {
	const orderedSpans = orderSpans(trace)
	const firstSpan = orderedSpans[0]?.span ?? trace.spans[0]
	const startedAtMicros = trace.spans.reduce((earliest, span) => Math.min(earliest, span.startTime), firstSpan?.startTime ?? 0)
	const endedAtMicros = trace.spans.reduce(
		(latest, span) => Math.max(latest, span.startTime + span.duration),
		(firstSpan?.startTime ?? 0) + (firstSpan?.duration ?? 0),
	)

	const spans: readonly TraceSpanItem[] = orderedSpans.map(({ span, depth }) => ({
		spanId: span.spanID,
		parentSpanId: parentSpanId(span),
		serviceName: trace.processes[span.processID]?.serviceName ?? requestedServiceName,
		operationName: span.operationName,
		startTime: new Date(span.startTime / 1000),
		durationMs: span.duration / 1000,
		status: spanStatus(span),
		depth,
		tags: tagMap(span.tags),
		warnings: [...(span.warnings ?? [])],
	}))

	const rootSpan = spans[0] ?? null

	return {
		traceId: trace.traceID,
		serviceName: rootSpan?.serviceName ?? requestedServiceName,
		rootOperationName: rootSpan?.operationName ?? "unknown",
		startedAt: new Date(startedAtMicros / 1000),
		durationMs: Math.max(0, (endedAtMicros - startedAtMicros) / 1000),
		spanCount: spans.length,
		errorCount: spans.filter((span) => span.status === "error").length,
		warnings: [...(trace.warnings ?? [])],
		spans,
	}
}

const parseTraceEffect = (requestedServiceName: string, trace: JaegerTrace) =>
	Effect.sync(() => parseTrace(requestedServiceName, trace)).pipe(
		Effect.withSpan("leto/TraceQueryService.parseTrace"),
		Effect.tap(() => Effect.annotateCurrentSpan({
			"trace.trace_id": trace.traceID,
			"trace.span_count": trace.spans.length,
		})),
	)

const sortServicesEffect = (services: readonly string[]) =>
	Effect.sync(() => [...services].sort((left, right) => left.localeCompare(right))).pipe(
		Effect.withSpan("leto/TraceQueryService.sortServices"),
	)

const sortTraceItemsEffect = (traces: readonly TraceItem[]) =>
	Effect.sync(() => [...traces].sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())).pipe(
		Effect.withSpan("leto/TraceQueryService.sortTraces"),
	)

export class TraceQueryService extends ServiceMap.Service<
	TraceQueryService,
	{
		readonly listServices: Effect.Effect<readonly string[], Error>
		readonly listRecentTraces: (serviceName: string) => Effect.Effect<readonly TraceItem[], Error>
	}
>()("leto/TraceQueryService") {}

export const TraceQueryServiceLive = Layer.succeed(
	TraceQueryService,
	TraceQueryService.of({
		listServices: Effect.fn("leto/TraceQueryService.listServices")(function* () {
			yield* Effect.annotateCurrentSpan("trace.query_url", config.otel.queryUrl)

			const startedAt = yield* Clock.currentTimeMillis
			const response = yield* queryJaeger<JaegerApiResponse<readonly string[]>>("/api/services").pipe(
				Effect.withSpan("leto/TraceQueryService.queryServices"),
			)
			const services = yield* sortServicesEffect(response.data ?? [])
			yield* Effect.annotateCurrentSpan("trace.query.elapsed_ms", (yield* Clock.currentTimeMillis) - startedAt)
			yield* Effect.annotateCurrentSpan("trace.service_count", services.length)
			return services
		})(),
		listRecentTraces: Effect.fn("leto/TraceQueryService.listRecentTraces")(function* (serviceName: string) {
			yield* Effect.annotateCurrentSpan({
				"trace.query_url": config.otel.queryUrl,
				"trace.service_name": serviceName,
				"trace.lookback_minutes": config.otel.traceLookbackMinutes,
				"trace.limit": config.otel.traceFetchLimit,
			})

			const startedAt = yield* Clock.currentTimeMillis
			const response = yield* queryJaeger<JaegerApiResponse<readonly JaegerTrace[]>>("/api/traces", {
				service: serviceName,
				limit: config.otel.traceFetchLimit,
				lookback: lookbackWindow(config.otel.traceLookbackMinutes),
			}).pipe(Effect.withSpan("leto/TraceQueryService.queryTracePage"))

			const traces = yield* Effect.all((response.data ?? []).map((trace) => parseTraceEffect(serviceName, trace)), {
				concurrency: "unbounded",
			}).pipe(Effect.withSpan("leto/TraceQueryService.parseTracePage"))

			const sortedTraces = yield* sortTraceItemsEffect(traces)
			yield* Effect.annotateCurrentSpan("trace.query.elapsed_ms", (yield* Clock.currentTimeMillis) - startedAt)

			yield* Effect.annotateCurrentSpan("trace.result_count", sortedTraces.length)
			return sortedTraces
		}),
	}),
)
