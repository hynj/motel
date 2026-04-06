import { config } from "./config.js"

export const effectSetupInstructions = () => `Set this app up to export local traces and logs to my local leto dev server.

Target endpoints:
- OTLP HTTP traces: ${config.otel.exporterUrl}
- OTLP HTTP logs: ${config.otel.logsExporterUrl}
- leto local API / UI: ${config.otel.queryUrl}

This repo uses Effect beta. Keep the change minimal and idiomatic for the target repo.

Requirements:
1. First inspect the repo's existing Effect runtime wiring and observability patterns.

2. Prefer the repo's existing Effect-native observability APIs if available.
   - If effect/unstable/observability is already the best fit, use that instead of adding @effect/opentelemetry.
   - Only add new OpenTelemetry SDK packages if the repo already uses them or they are clearly required.

3. Add a shared telemetry layer that exports:
   - traces to ${config.otel.exporterUrl}
   - logs to ${config.otel.logsExporterUrl}

4. Merge that layer into the main runtime once, not per-feature.

5. Wrap meaningful workflows with Effect.fn("...") and a few useful child spans.

6. Emit Effect.logInfo / Effect.logWarning / Effect.logError in those workflows.

7. Prefer structured log annotations so important fields are queryable, not only embedded in the log body.

8. Add useful span annotations and events for milestones.

9. Focus on the server and runtime paths where Effect is already used. I want to inspect which spans take the most time in a normal agent or session flow.

10. Verify with:
    curl ${config.otel.queryUrl}/api/services
    curl "${config.otel.queryUrl}/api/traces?service=<service-name>&limit=20&lookback=1h"
    curl "${config.otel.queryUrl}/api/traces/search?service=<service-name>&operation=<text-fragment>&status=error&attr.sessionID=<session-id>"
    curl "${config.otel.queryUrl}/api/traces/stats?groupBy=operation&agg=p95_duration&service=<service-name>"
    curl "${config.otel.queryUrl}/api/spans/<span-id>"
    curl "${config.otel.queryUrl}/api/spans/<span-id>/logs"
    curl "${config.otel.queryUrl}/api/spans/search?service=<service-name>&operation=Format.file&parentOperation=Tool.write&attr.sessionID=<session-id>"
    curl "${config.otel.queryUrl}/api/traces/<trace-id>/spans"
    curl "${config.otel.queryUrl}/api/logs?service=<service-name>"
    curl "${config.otel.queryUrl}/api/logs/search?service=<service-name>&body=<text-fragment>"
    curl "${config.otel.queryUrl}/api/logs/stats?groupBy=severity&agg=count&service=<service-name>"
    curl "${config.otel.queryUrl}/api/facets?type=logs&field=severity"
    curl ${config.otel.queryUrl}/openapi.json

List and search responses include a meta object with nextCursor when more data is available.
CLI search and stats commands also accept extra attr.<key>=<value> filters.

Use the repo's existing patterns where possible. Avoid adding new observability infrastructure unless the target repo truly needs it.`
