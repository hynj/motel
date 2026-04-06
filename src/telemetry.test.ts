import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, References } from "effect"
import { attributeFiltersFromArgs, isAttributeFilterToken } from "./queryFilters.js"

describe("leto telemetry store", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "leto-test-"))
	const dbPath = join(tempDir, "telemetry.sqlite")
	let storeRuntime: Awaited<typeof import("./runtime.ts")>["storeRuntime"]
	let TelemetryStore: Awaited<typeof import("./services/TelemetryStore.ts")>["TelemetryStore"]
	let letoOpenApiSpec: Awaited<typeof import("./httpApi.ts")>["letoOpenApiSpec"]

	beforeAll(async () => {
		process.env.LETO_OTEL_DB_PATH = dbPath
		process.env.LETO_OTEL_RETENTION_HOURS = "24"
		const suffix = `?test=${Date.now()}`
		;({ storeRuntime } = await import(`./runtime.ts${suffix}`))
		;({ TelemetryStore } = await import(`./services/TelemetryStore.ts${suffix}`))
		;({ letoOpenApiSpec } = await import(`./httpApi.ts${suffix}`))

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
		expect(letoOpenApiSpec.paths["/api/spans/{spanId}"]).toBeDefined()
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
		expect(result[0]?.group).toBe("ERROR")
		expect(result[0]?.value).toBe(1)
		expect(result[1]?.group).toBe("INFO")
		expect(result[1]?.value).toBe(1)
	})

	it("documents the stats routes in OpenAPI", () => {
		expect(letoOpenApiSpec.paths["/api/traces/stats"]).toBeDefined()
		expect(letoOpenApiSpec.paths["/api/logs/stats"]).toBeDefined()
		expect(letoOpenApiSpec.paths["/api/spans/{spanId}/logs"]).toBeDefined()
		expect(letoOpenApiSpec.paths["/api/spans/search"]).toBeDefined()
		expect(letoOpenApiSpec.paths["/api/traces/{traceId}/spans"]).toBeDefined()
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
