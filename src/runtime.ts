import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Layer, ManagedRuntime } from "effect"
import { config } from "./config.js"
import { TraceQueryServiceLive } from "./services/TraceQueryService.js"

const telemetryLayer = NodeSdk.layer(() => ({
	spanProcessor: new SimpleSpanProcessor(
		new OTLPTraceExporter({
			url: config.otel.exporterUrl,
		}),
	),
	resource: {
		serviceName: config.otel.serviceName,
		attributes: {
			"deployment.environment.name": "local",
			"service.instance.id": "leto.local",
		},
	},
}))

const AppRuntimeLive = config.otel.enabled ? Layer.mergeAll(TraceQueryServiceLive, telemetryLayer) : TraceQueryServiceLive

export const runtime = ManagedRuntime.make(AppRuntimeLive)
