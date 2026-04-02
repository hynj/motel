import { config } from "./config.js"

const buildQueryUrl = (path: string, searchParams: Readonly<Record<string, string | number | undefined>> = {}) => {
	const baseUrl = config.otel.queryUrl.endsWith("/") ? config.otel.queryUrl : `${config.otel.queryUrl}/`
	const url = new URL(path.startsWith("/") ? path.slice(1) : path, baseUrl)

	for (const [key, value] of Object.entries(searchParams)) {
		if (value === undefined || value === "") continue
		url.searchParams.set(key, String(value))
	}

	return url
}

const effectSetupInstructions = () => `Set this app up to export local OpenTelemetry traces to my local Jaeger dev collector.

Target endpoints:
- OTLP HTTP ingest: ${config.otel.exporterUrl}
- Jaeger query/UI: ${config.otel.queryUrl}

If this codebase uses Effect beta, wire tracing like this:

1. Install dependencies:
   bun add @effect/opentelemetry @opentelemetry/exporter-trace-otlp-http @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node

2. Add a telemetry layer:

import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"

const TelemetryLive = NodeSdk.layer(() => ({
  spanProcessor: new SimpleSpanProcessor(
    new OTLPTraceExporter({
      url: "${config.otel.exporterUrl}",
    }),
  ),
  resource: {
    serviceName: "<replace-service-name>",
    attributes: {
      "deployment.environment.name": "local",
    },
  },
}))

3. Merge that layer into the main runtime.

4. Name important effects with Effect.fn("...") and add spans around meaningful workflows.

5. Verify the service shows up in Jaeger:
   curl ${config.otel.queryUrl}/api/services

Keep the change minimal and idiomatic for the target repo.`

const fetchJson = async (url: URL) => {
	const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
	if (!response.ok) {
		const detail = await response.text()
		throw new Error(`Query failed ${response.status}: ${detail.trim() || response.statusText}`)
	}

	return await response.json()
}

const [command, ...args] = process.argv.slice(2)

switch (command) {
	case "services": {
		const result = await fetchJson(buildQueryUrl("/api/services"))
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "traces": {
		const service = args[0] ?? config.otel.serviceName
		const limit = args[1] ? Number.parseInt(args[1], 10) : config.otel.traceFetchLimit
		const result = await fetchJson(buildQueryUrl("/api/traces", { service, limit, lookback: "1h" }))
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "trace": {
		const traceId = args[0]
		if (!traceId) {
			throw new Error("Usage: bun run cli trace <trace-id>")
		}

		const result = await fetchJson(buildQueryUrl(`/api/traces/${traceId}`))
		console.log(JSON.stringify(result, null, 2))
		break
	}

	case "instructions": {
		console.log(effectSetupInstructions())
		break
	}

	case "endpoints": {
		console.log(JSON.stringify({
			exporterUrl: config.otel.exporterUrl,
			queryUrl: config.otel.queryUrl,
		}, null, 2))
		break
	}

	default: {
		console.log(`Usage:
	bun run cli services
	bun run cli traces [service] [limit]
	bun run cli trace <trace-id>
	bun run cli instructions
	bun run cli endpoints`)
	}
}
