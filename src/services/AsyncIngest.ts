/**
 * Main-thread client for the telemetry worker's ingest RPCs.
 *
 * The HTTP handlers for POST /v1/traces and POST /v1/logs call into
 * this service instead of `TelemetryStore.ingestTraces/Logs`. Each
 * method sends a typed message to the worker, awaits the reply, and
 * returns the worker's result as an Effect. While the worker is
 * serialising a big batch into SQLite, the main thread's event loop
 * is FREE to answer /api/* queries — that's the whole point of the
 * offload. Without this, /api/health and friends queued behind long
 * ingests and reported p95 latencies of 3-5 seconds; after, they
 * stay responsive regardless of ingest load.
 *
 * The worker is spawned as a scope'd resource inside the layer. The
 * protocol pool is sized at 1 because SQLite only supports a single
 * writer at a time anyway — running N concurrent workers would just
 * queue them on SQLite's lock. When the outer scope closes (server
 * shutdown), `BunWorker.layer`'s finalizer sends a close message and
 * terminates the worker if it doesn't exit gracefully in 5s.
 */

import * as BunWorker from "@effect/platform-bun/BunWorker"
import { Cause, Context, Effect, Layer, Scope } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import type { WorkerError } from "effect/unstable/workers/WorkerError"
import { IngestRpcs } from "./ingestRpc.ts"

// RpcClient.make always surfaces RpcClientError in addition to the
// group's declared errors (transport failures, worker crashes, etc.),
// so the service shape has to mirror that. Without the explicit error
// type param, TS treats the declared and observed client types as
// unrelated structural mismatches.
export class AsyncIngest extends Context.Service<
	AsyncIngest,
	RpcClient.FromGroup<typeof IngestRpcs, RpcClientError | WorkerError>
>()("@motel/AsyncIngest") {}

// Protocol: RpcClient.layerProtocolWorker manages a worker pool and
// speaks msgpack over structured-clone messages. `size: 1` matches
// SQLite's single-writer constraint.
const WorkerProtocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
	Layer.provide(RpcSerialization.layerMsgPack),
	Layer.provide(
		BunWorker.layer(() => new Worker(new URL("./telemetryWorker.ts", import.meta.url))),
	),
	// #region motel debug
	Layer.provideMerge(
		Layer.succeed(
			RpcClient.ConnectionHooks,
			RpcClient.ConnectionHooks.of({
				onConnect: Effect.logInfo("motel debug async ingest worker connected", {
					debug: {
						session: "motel-ingest-503-2026-04-20",
						hypothesis: "rpc-connect",
						step: "connection",
						label: "rpc worker protocol connected",
					},
				}),
				onDisconnect: Effect.logWarning("motel debug async ingest worker disconnected", {
					debug: {
						session: "motel-ingest-503-2026-04-20",
						hypothesis: "rpc-connect",
						step: "disconnect",
						label: "rpc worker protocol disconnected",
					},
				}),
			}),
		),
	),
	// #endregion motel debug
)

const summarizeTracePayload = (input: { readonly payload: any }) => ({
	resourceSpans: Array.isArray(input.payload?.resourceSpans) ? input.payload.resourceSpans.length : 0,
	spanCount: Array.isArray(input.payload?.resourceSpans)
		? input.payload.resourceSpans.reduce((count: number, resourceSpans: any) =>
			count + (Array.isArray(resourceSpans?.scopeSpans)
				? resourceSpans.scopeSpans.reduce((scopeCount: number, scopeSpans: any) =>
					scopeCount + (Array.isArray(scopeSpans?.spans) ? scopeSpans.spans.length : 0), 0)
				: 0), 0)
		: 0,
})

const summarizeLogPayload = (input: { readonly payload: any }) => ({
	resourceLogs: Array.isArray(input.payload?.resourceLogs) ? input.payload.resourceLogs.length : 0,
	logCount: Array.isArray(input.payload?.resourceLogs)
		? input.payload.resourceLogs.reduce((count: number, resourceLogs: any) =>
			count + (Array.isArray(resourceLogs?.scopeLogs)
				? resourceLogs.scopeLogs.reduce((scopeCount: number, scopeLogs: any) =>
					scopeCount + (Array.isArray(scopeLogs?.logRecords) ? scopeLogs.logRecords.length : 0), 0)
				: 0), 0)
		: 0,
})

export const AsyncIngestLive = Layer.effect(
	AsyncIngest,
	Effect.gen(function*() {
		const scope = yield* Scope.Scope
		// Keep daemon startup cheap: creating the RPC client here would eagerly
		// spawn the worker and make /api/health wait on the worker's SQLite
		// bootstrap. Cache a lazy initializer instead so the worker only starts
		// on the first ingest request, but is still shared thereafter.
		const getClient = yield* Effect.gen(function*() {
			const protocolContext = yield* Layer.buildWithScope(WorkerProtocol, scope)
			return yield* RpcClient.make(IngestRpcs).pipe(
				Effect.provide(protocolContext),
				Effect.provideService(Scope.Scope, scope),
			)
		}).pipe(Effect.cached)
		return AsyncIngest.of({
			ingestTraces: (input, options) =>
				Effect.gen(function*() {
					yield* Effect.logInfo("motel debug async ingest traces dispatch", {
						debug: {
							session: "motel-ingest-503-2026-04-20",
							hypothesis: "worker-bootstrap",
							step: "dispatch",
							label: "main thread dispatching traces rpc",
						},
						...summarizeTracePayload(input),
					})
					const client = yield* getClient
					return yield* client.ingestTraces(input, options).pipe(
						// #region motel debug
						Effect.tapCause((cause) =>
							Effect.logError("motel debug async ingest traces rpc failed", {
								debug: {
									session: "motel-ingest-503-2026-04-20",
									hypothesis: "rpc-connect",
									step: "rpc-error",
									label: "main thread traces rpc failed before reply",
								},
								cause: Cause.pretty(cause),
								...summarizeTracePayload(input),
							}),
						),
						// #endregion motel debug
					)
				}),
			ingestLogs: (input, options) =>
				Effect.gen(function*() {
					yield* Effect.logInfo("motel debug async ingest logs dispatch", {
						debug: {
							session: "motel-ingest-503-2026-04-20",
							hypothesis: "worker-bootstrap",
							step: "dispatch",
							label: "main thread dispatching logs rpc",
						},
						...summarizeLogPayload(input),
					})
					const client = yield* getClient
					return yield* client.ingestLogs(input, options).pipe(
						// #region motel debug
						Effect.tapCause((cause) =>
							Effect.logError("motel debug async ingest logs rpc failed", {
								debug: {
									session: "motel-ingest-503-2026-04-20",
									hypothesis: "rpc-connect",
									step: "rpc-error",
									label: "main thread logs rpc failed before reply",
								},
								cause: Cause.pretty(cause),
								...summarizeLogPayload(input),
							}),
						),
						// #endregion motel debug
					)
				}),
		})
	}),
)
