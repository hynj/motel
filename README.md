# leto

OpenTUI local OTEL viewer for development.

## Commands

- `bun install`
- `bun run otel:up`
- `bun run dev`
- `bun run cli services`
- `bun run cli traces <service>`
- `bun run instructions`
- `bun run typecheck`

## Local ports

This repo uses dedicated Jaeger ports so it does not collide with the other Jaeger stacks already running on your machine.

- OTLP gRPC: `127.0.0.1:25317`
- OTLP HTTP: `http://127.0.0.1:25318/v1/traces`
- Jaeger query API and UI: `http://127.0.0.1:27686`

Other local apps can send spans to:

```bash
http://127.0.0.1:25318/v1/traces
```

Agents and scripts can query traces from:

```bash
http://127.0.0.1:27686/api/services
http://127.0.0.1:27686/api/traces?service=<service>&limit=20&lookback=1h
```

## TUI keys

- `?`: show or hide keyboard shortcut help
- `j` / `k` or `up` / `down`: move selection
- `gg` or `home`: jump to the first trace or first span
- `G` or `end`: jump to the last trace or last span
- `ctrl-u` / `pageup`: move up by one page
- `ctrl-d` / `pagedown`: move down by one page
- `[` / `]`: switch service
- `enter`: enter span navigation or open selected span detail
- `esc`: leave span detail or span navigation
- `r`: refresh
- `c`: copy a paste-ready Effect setup prompt for another app
- `o`: open selected trace in browser
- `q`: quit

## How It Works

`leto` is not the collector. Jaeger is.

- Other apps export spans to `http://127.0.0.1:25318/v1/traces`
- Jaeger stores them and exposes search/query APIs on `http://127.0.0.1:27686`
- `leto` reads those APIs and renders the traces in OpenTUI

So yes: another service has to point its OTEL exporter at this local Jaeger instance.

The easiest flow is:

1. Run `bun run otel:up` here.
2. In `leto`, press `c`.
3. Paste the copied instructions into an agent working in the other service.
4. Have that service export OTEL traces to `http://127.0.0.1:25318/v1/traces`.
5. Refresh `leto` and switch to that service with `[` / `]`.

## For Agents

An agent does not need to talk to the TUI.

Use one of these:

1. Jaeger HTTP API directly

```bash
curl http://127.0.0.1:27686/api/services
curl "http://127.0.0.1:27686/api/traces?service=my-service&limit=20&lookback=1h"
curl http://127.0.0.1:27686/api/traces/<trace-id>
```

2. The local CLI wrapper in this repo

```bash
bun run cli services
bun run cli traces my-service
bun run cli trace <trace-id>
bun run instructions
```

Recommended shape going forward:

1. Keep Jaeger's HTTP API as the source of truth.
2. Keep `leto` as the interactive viewer.
3. Keep the CLI as a thin convenience wrapper for agents and scripts.
4. Make other apps do only one thing: export OTLP spans to `http://127.0.0.1:25318/v1/traces`.
