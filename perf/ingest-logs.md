# Ingest Logs

## Goal

Reduce `TelemetryStore.ingestLogs` latency on realistic OTLP log batches.

## Benchmark

```bash
bun run bench:ingest-logs --warmups 1 --iterations 5
```

## Primary Metrics

- `ingest_logs_ms`
- `ingest_logs_mad_ms`

## Seed Shape

The benchmark ingests one OTLP log payload containing:

- thousands of log rows
- trace/span ids
- resource + per-log attributes
- enough body text to exercise `log_body_fts`

## Files In Scope

- `src/services/TelemetryStore.ts`
- `scripts/bench-ingest-logs.ts`

## Likely Hypotheses

1. per-log `log_body_fts` maintenance is the dominant cost
2. per-log attribute fanout still has measurable overhead even after batching
3. repeated JSON serialization for attributes/body is expensive on large batches

## Baseline

Measured on 2026-04-18 with:

```bash
bun run bench:ingest-logs --warmups 1 --iterations 5
```

on:

- `8000` inserted logs per run

Initial median:

- `ingest_logs_ms = 275.8ms`

## First Keep

Changed log-body FTS maintenance from one `INSERT INTO log_body_fts` per log to batched multi-row inserts after each payload transaction.

Current median after the change:

- `ingest_logs_ms = 192.0ms`

## Root Cause

The main cost was log-body FTS maintenance done one log at a time.

Batching those writes cut the benchmark materially with no behavior change.
