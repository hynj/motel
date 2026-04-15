import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, References } from "effect"
import { attributeFiltersFromArgs, isAttributeFilterToken } from "./queryFilters.js"

describe("motel telemetry store", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "motel-test-"))
	const dbPath = join(tempDir, "telemetry.sqlite")
	let storeRuntime: Awaited<typeof import("./runtime.ts")>["storeRuntime"]
	let TelemetryStore: Awaited<typeof import("./services/TelemetryStore.ts")>["TelemetryStore"]
	let motelOpenApiSpec: Awaited<typeof import("./httpApi.ts")>["motelOpenApiSpec"]

	beforeAll(async () => {
		process.env.MOTEL_OTEL_DB_PATH = dbPath
		process.env.MOTEL_OTEL_RETENTION_HOURS = "24"
		const suffix = `?test=${Date.now()}`
		;({ storeRuntime } = await import(`./runtime.ts${suffix}`))
		;({ TelemetryStore } = await import(`./services/TelemetryStore.ts${suffix}`))
		;({ motelOpenApiSpec } = await import(`./httpApi.ts${suffix}`))

		const nowNanos = BigInt(Date.now()) * 1_000_000n
		const oneSecond = 1_000_000_000n

		const ingest = Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				Effect.flatMap(
					store.ingestTraces({
					resourceSpans: [
						{
							resource: {
								attributes: [
									{ key: "service.name", value: { stringValue: "test-api" } },
									{ key: "deployment.environment.name", value: { stringValue: "local" } },
								],
							},
							scopeSpans: [
								{
									scope: { name: "test-scope" },
									spans: [
										{
											traceId: "trace-1",
											spanId: "root-1",
											name: "SessionProcessor.stream",
											kind: 2,
											startTimeUnixNano: String(nowNanos),
											endTimeUnixNano: String(nowNanos + 4n * oneSecond),
											attributes: [
												{ key: "sessionID", value: { stringValue: "session-1" } },
												{ key: "modelID", value: { stringValue: "gpt-5.4" } },
											],
										},
										{
											traceId: "trace-1",
											spanId: "child-1",
											parentSpanId: "root-1",
											name: "tool.call",
											kind: 1,
											startTimeUnixNano: String(nowNanos + oneSecond),
											endTimeUnixNano: String(nowNanos + 2n * oneSecond),
											attributes: [
												{ key: "tool", value: { stringValue: "search" } },
											],
										},
									],
								},
							],
						},
						{
							resource: {
								attributes: [
									{ key: "service.name", value: { stringValue: "test-api" } },
									{ key: "deployment.environment.name", value: { stringValue: "local" } },
								],
							},
							scopeSpans: [
								{
									scope: { name: "test-scope" },
									spans: [
										{
											traceId: "trace-2",
											spanId: "root-2",
											name: "SessionProcessor.stream",
											kind: 2,
											startTimeUnixNano: String(nowNanos + 10n * oneSecond),
											endTimeUnixNano: String(nowNanos + 12n * oneSecond),
											status: { code: 2 },
											attributes: [
												{ key: "sessionID", value: { stringValue: "session-2" } },
												{ key: "modelID", value: { stringValue: "gpt-5.4" } },
											],
										},
									],
								},
							],
						},
					],
					}),
					() => store.ingestLogs({
					resourceLogs: [
						{
							resource: { attributes: [{ key: "service.name", value: { stringValue: "test-api" } }] },
							scopeLogs: [
								{
									scope: { name: "app" },
									logRecords: [
										{
											timeUnixNano: String(nowNanos + 500_000_000n),
											severityText: "INFO",
											traceId: "trace-1",
											spanId: "child-1",
											body: { stringValue: "tool call started" },
											attributes: [{ key: "tool", value: { stringValue: "search" } }],
										},
										{
											timeUnixNano: String(nowNanos + 11n * oneSecond),
											severityText: "ERROR",
											traceId: "trace-2",
											spanId: "root-2",
											body: { stringValue: "stream failed" },
											attributes: [{ key: "tool", value: { stringValue: "none" } }],
										},
									],
								},
							],
						},
					],
					}),
				),
		)

		await storeRuntime.runPromise(ingest.pipe(Effect.provideService(References.MinimumLogLevel, "None")))
	})

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("filters traces by attr.* fields", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraces({
					serviceName: "test-api",
					attributeFilters: {
						sessionID: "session-1",
						"deployment.environment.name": "local",
					},
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("looks up a span directly by spanId", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) => store.getSpan("child-1")).pipe(
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		)

		expect(result?.traceId).toBe("trace-1")
		expect(result?.rootOperationName).toBe("SessionProcessor.stream")
		expect(result?.span.operationName).toBe("tool.call")
		expect(result?.span.depth).toBe(1)
	})

	it("filters logs by spanId", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({
					spanId: "child-1",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("tool call started")
	})

	it("searches spans by operation, parent operation, and attr filters", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchSpans({
					serviceName: "test-api",
					operation: "tool.call",
					parentOperation: "SessionProcessor.stream",
					attributeFilters: {
						tool: "search",
					},
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
		expect(result[0]?.span.operationName).toBe("tool.call")
		expect(result[0]?.parentOperationName).toBe("SessionProcessor.stream")
	})

	it("lists spans for a trace", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) => store.listTraceSpans("trace-1")).pipe(
				Effect.provideService(References.MinimumLogLevel, "None"),
			),
		)

		expect(result).toHaveLength(2)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("documents the span lookup route in OpenAPI", () => {
		expect(motelOpenApiSpec.paths["/api/spans/{spanId}"]).toBeDefined()
	})

	it("aggregates trace stats by operation", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.traceStats({
					groupBy: "operation",
					agg: "avg_duration",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.group).toBe("SessionProcessor.stream")
		expect(result[0]?.count).toBe(2)
		expect(result[0]?.value).toBe(3000)
	})

	it("aggregates log stats by severity", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.logStats({
					groupBy: "severity",
					agg: "count",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		const errorGroup = result.find((r) => r.group === "ERROR")
		const infoGroup = result.find((r) => r.group === "INFO")
		expect(errorGroup?.value).toBe(1)
		expect(infoGroup?.value).toBe(1)
	})

	it("documents the stats routes in OpenAPI", () => {
		expect(motelOpenApiSpec.paths["/api/traces/stats"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/logs/stats"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/spans/{spanId}/logs"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/spans/search"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/traces/{traceId}/spans"]).toBeDefined()
	})

	it("lists trace summaries without loading spans", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.listTraceSummaries(null),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		// Ordered by start time descending
		expect(result[0]?.traceId).toBe("trace-2")
		expect(result[1]?.traceId).toBe("trace-1")
		// Summary fields are correct
		expect(result[1]?.serviceName).toBe("test-api")
		expect(result[1]?.rootOperationName).toBe("SessionProcessor.stream")
		expect(result[1]?.spanCount).toBe(2)
		expect(result[1]?.durationMs).toBe(4000)
	})

	it("lists trace summaries filtered by service", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.listTraceSummaries("test-api"),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
	})

	it("searches trace summaries with status filter", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraceSummaries({
					serviceName: "test-api",
					status: "error",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-2")
		expect(result[0]?.errorCount).toBeGreaterThan(0)
	})

	it("searches trace summaries with attribute filters", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraceSummaries({
					serviceName: "test-api",
					attributeFilters: { sessionID: "session-1" },
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("searches trace summaries with operation filter", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchTraceSummaries({
					serviceName: "test-api",
					operation: "tool.call",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.traceId).toBe("trace-1")
	})

	it("filters logs by severity", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({ serviceName: "test-api", severity: "ERROR" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("stream failed")
		expect(result[0]?.severityText).toBe("ERROR")
	})

	it("filters logs by severity case-insensitively", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({ serviceName: "test-api", severity: "error" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.severityText).toBe("ERROR")
	})

	it("searches log body case-insensitively", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({ serviceName: "test-api", body: "STREAM FAILED" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("stream failed")
	})

	it("combines severity and body filters", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.searchLogs({ serviceName: "test-api", severity: "INFO", body: "tool" }),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.body).toBe("tool call started")
	})

	it("computes facet status without N+1 queries", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.listFacets({
					type: "traces",
					field: "status",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		const errorFacet = result.find((r) => r.value === "error")
		const okFacet = result.find((r) => r.value === "ok")
		expect(errorFacet?.count).toBe(1)
		expect(okFacet?.count).toBe(1)
	})

	it("computes logStats with SQL aggregation", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.logStats({
					groupBy: "service",
					agg: "count",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.group).toBe("test-api")
		expect(result[0]?.value).toBe(2)
	})

	it("computes traceStats count via SQL", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.traceStats({
					groupBy: "status",
					agg: "count",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(2)
		const errorGroup = result.find((r) => r.group === "error")
		const okGroup = result.find((r) => r.group === "ok")
		expect(errorGroup?.count).toBe(1)
		expect(okGroup?.count).toBe(1)
	})

	it("computes traceStats error_rate via SQL", async () => {
		const result = await storeRuntime.runPromise(
			Effect.flatMap(TelemetryStore.asEffect(), (store) =>
				store.traceStats({
					groupBy: "service",
					agg: "error_rate",
					serviceName: "test-api",
				}),
			).pipe(Effect.provideService(References.MinimumLogLevel, "None")),
		)

		expect(result).toHaveLength(1)
		expect(result[0]?.group).toBe("test-api")
		expect(result[0]?.value).toBe(0.5) // 1 error trace out of 2
	})

	it("documents the docs routes in OpenAPI", () => {
		expect(motelOpenApiSpec.paths["/api/docs"]).toBeDefined()
		expect(motelOpenApiSpec.paths["/api/docs/{name}"]).toBeDefined()
	})

	it("parses attr filters consistently for CLI-style args", () => {
		expect(isAttributeFilterToken("attr.sessionID=sess_123")).toBe(true)
		expect(isAttributeFilterToken("sessionID=sess_123")).toBe(false)
		expect(attributeFiltersFromArgs(["attr.sessionID=sess_123", "attr.tool=search"])).toEqual({
			sessionID: "sess_123",
			tool: "search",
		})
	})
})
