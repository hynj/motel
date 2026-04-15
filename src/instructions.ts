import { config } from "./config.js"

export const otelServerInstructions = () => `Motel is a local OpenTelemetry server for traces and logs. Use it for OTLP/HTTP ingestion and as a runtime evidence loop for debugging.

Base URL: ${config.otel.queryUrl}

OTLP ingest:
- Traces: POST ${config.otel.exporterUrl}
- Logs: POST ${config.otel.logsExporterUrl}
- Content-Type: application/json
- No auth required

Query endpoints:
- Health: GET ${config.otel.queryUrl}/api/health
- Services: GET ${config.otel.queryUrl}/api/services
- Traces: GET ${config.otel.queryUrl}/api/traces
- Trace search: GET ${config.otel.queryUrl}/api/traces/search
- Trace stats: GET ${config.otel.queryUrl}/api/traces/stats
- Trace spans: GET ${config.otel.queryUrl}/api/traces/<trace-id>/spans
- Trace logs: GET ${config.otel.queryUrl}/api/traces/<trace-id>/logs
- Span search: GET ${config.otel.queryUrl}/api/spans/search
- Span detail: GET ${config.otel.queryUrl}/api/spans/<span-id>
- Span logs: GET ${config.otel.queryUrl}/api/spans/<span-id>/logs
- Logs: GET ${config.otel.queryUrl}/api/logs
- Log search: GET ${config.otel.queryUrl}/api/logs/search
- Log stats: GET ${config.otel.queryUrl}/api/logs/stats
- Facets: GET ${config.otel.queryUrl}/api/facets?type=logs&field=severity
- OpenAPI: GET ${config.otel.queryUrl}/openapi.json
- Docs: GET ${config.otel.queryUrl}/api/docs

Documentation:
- Debug workflow: GET ${config.otel.queryUrl}/api/docs/debug
- Effect guide: GET ${config.otel.queryUrl}/api/docs/effect

For full API details, query the OpenAPI spec at ${config.otel.queryUrl}/openapi.json.
For setup guidance with Effect or other frameworks, query ${config.otel.queryUrl}/api/docs/effect.

Debug workflow (hypothesis-driven):

1. Verify motel is running: curl ${config.otel.queryUrl}/api/health
2. Generate 3-5 hypotheses about why the bug occurs before touching code.
3. Add temporary instrumentation to confirm or reject all hypotheses.
   - Use whatever tracing/logging the codebase already has (spans, structured logs, annotations).
   - Tag every debug point with structured attributes: debug.session, debug.hypothesis, debug.step, debug.label.
   - Wrap every temporary block in markers for cleanup:
     // #region motel debug
     // ... instrumentation ...
     // #endregion motel debug
4. Reproduce the issue.
5. Query motel for evidence:
   - curl "${config.otel.queryUrl}/api/spans/search?service=<svc>&attr.debug.hypothesis=<id>"
   - curl "${config.otel.queryUrl}/api/logs/search?service=<svc>&attr.debug.session=<session>"
6. Evaluate each hypothesis (CONFIRMED / REJECTED / INCONCLUSIVE) with cited evidence.
7. Fix only with runtime evidence. Keep instrumentation during verification.
8. Reproduce again to verify the fix with before/after evidence.
9. If the fix failed, revert speculative changes, generate new hypotheses, and iterate.
10. After verified success, remove all #region motel debug blocks and confirm with git diff.

Rules:
- Never fix without runtime evidence.
- Do not remove instrumentation before verification succeeds.
- Do not log secrets, tokens, passwords, or PII.
- Revert code from rejected hypotheses — do not let unproven changes accumulate.
- Use attr.<key>=<value> query params to filter by structured attributes.
- List and search responses include meta.nextCursor when more data is available.`
