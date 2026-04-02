import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useAtom } from "@effect/atom-react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { Effect } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import { useEffect, useRef } from "react"
import { config } from "./config.js"
import type { TraceItem, TraceSpanItem } from "./domain.js"
import { runtime } from "./runtime.js"
import { TraceQueryService } from "./services/TraceQueryService.js"

type LoadStatus = "loading" | "ready" | "error"
type DetailView = "waterfall" | "span-detail"

interface TraceState {
	readonly status: LoadStatus
	readonly services: readonly string[]
	readonly data: readonly TraceItem[]
	readonly error: string | null
	readonly fetchedAt: Date | null
}

const loadTraceServices = () => runtime.runPromise(Effect.flatMap(TraceQueryService.asEffect(), (service) => service.listServices))
const loadRecentTraces = (serviceName: string) => runtime.runPromise(Effect.flatMap(TraceQueryService.asEffect(), (service) => service.listRecentTraces(serviceName)))

const colors = {
	text: "#ede7da",
	muted: "#9f9788",
	separator: "#6f685d",
	accent: "#f4a51c",
	error: "#f97316",
	selectedBg: "#1d2430",
	selectedText: "#f8fafc",
	count: "#d7c5a1",
	passing: "#7dd3a3",
	defaultService: "#93c5fd",
	footerBg: "#000000",
} as const

const initialTraceState: TraceState = {
	status: "loading",
	services: [],
	data: [],
	error: null,
	fetchedAt: null,
}

const traceStateAtom = Atom.make(initialTraceState).pipe(Atom.keepAlive)
const selectedTraceIndexAtom = Atom.make(0).pipe(Atom.keepAlive)
const selectedTraceServiceAtom = Atom.make<string | null>(config.otel.serviceName).pipe(Atom.keepAlive)
const refreshNonceAtom = Atom.make(0).pipe(Atom.keepAlive)
const noticeAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)
const selectedSpanIndexAtom = Atom.make<number | null>(null).pipe(Atom.keepAlive)
const detailViewAtom = Atom.make<DetailView>("waterfall").pipe(Atom.keepAlive)
const showHelpAtom = Atom.make(false).pipe(Atom.keepAlive)

const SEPARATOR = " · "
const DETAIL_DIVIDER_ROW = 7

const BlankRow = () => <box height={1} />

const PlainLine = ({ text, fg = colors.text, bold = false }: { text: string; fg?: string; bold?: boolean }) => (
	<box height={1}>
		{bold ? (
			<text wrapMode="none" truncate fg={fg} attributes={TextAttributes.BOLD}>
				{text}
			</text>
		) : (
			<text wrapMode="none" truncate fg={fg}>
				{text}
			</text>
		)}
	</box>
)

const TextLine = ({ children, fg = colors.text, bg }: { children: React.ReactNode; fg?: string; bg?: string | undefined }) => (
	<box height={1}>
		{bg ? (
			<text wrapMode="none" truncate fg={fg} bg={bg}>
				{children}
			</text>
		) : (
			<text wrapMode="none" truncate fg={fg}>
				{children}
			</text>
		)}
	</box>
)

const truncateText = (text: string, width: number) => {
	if (width <= 0) return ""
	if (text.length <= width) return text
	if (width <= 3) return text.slice(0, width)
	return `${text.slice(0, width - 3)}...`
}

const AlignedHeaderLine = ({ left, right, width, rightFg = colors.muted }: { left: string; right: string; width: number; rightFg?: string }) => {
	const availableRightWidth = Math.max(8, width - left.length - 2)
	const rightText = truncateText(right, availableRightWidth)
	const gap = Math.max(2, width - left.length - rightText.length)

	return (
		<TextLine>
			<span fg={colors.accent} attributes={TextAttributes.BOLD}>{left}</span>
			<span fg={colors.muted}>{" ".repeat(gap)}</span>
			<span fg={rightFg}>{rightText}</span>
		</TextLine>
	)
}

const FooterHints = ({ spanNavActive, detailView, width }: { spanNavActive: boolean; detailView: DetailView; width: number }) => {
	const firstLine = "j/k move  ^n/^p trace  ^d/^u page  gg/G top/end"
	const secondLine = [
		`enter ${spanNavActive && detailView === "waterfall" ? "detail" : "spans"}`,
		spanNavActive ? `esc ${detailView === "span-detail" ? "back" : "traces"}` : null,
		"[ ] service",
		"? hide",
		"r ref",
		"o open",
		"c copy",
		"q quit",
	]
		.filter((segment) => segment !== null)
		.join("  ")

	return (
		<box flexDirection="column">
			<TextLine fg={colors.muted} bg={colors.footerBg}>
				{fitCell(firstLine, width)}
			</TextLine>
			<TextLine fg={colors.muted} bg={colors.footerBg}>
				{fitCell(secondLine, width)}
			</TextLine>
		</box>
	)
}

const Divider = ({ width, junctionAt, junctionChar }: { width: number; junctionAt?: number; junctionChar?: string }) => {
	if (junctionAt === undefined || junctionChar === undefined || junctionAt < 0 || junctionAt >= width) {
		return <PlainLine text={"─".repeat(Math.max(1, width))} fg={colors.separator} />
	}

	return <PlainLine text={`${"─".repeat(junctionAt)}${junctionChar}${"─".repeat(Math.max(0, width - junctionAt - 1))}`} fg={colors.separator} />
}

const SeparatorColumn = ({ height, junctionRow }: { height: number; junctionRow?: number }) => (
	<box width={1} height={height} flexDirection="column">
		{Array.from({ length: height }, (_, index) => (
			<PlainLine key={index} text={junctionRow === index ? "├" : "│"} fg={colors.separator} />
		))}
	</box>
)

const fitCell = (text: string, width: number, align: "left" | "right" = "left") => {
	const trimmed = text.length > width ? `${text.slice(0, Math.max(0, width - 3))}...` : text
	return align === "right" ? trimmed.padStart(width, " ") : trimmed.padEnd(width, " ")
}

const formatShortDate = (date: Date) => date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })
const formatTimestamp = (date: Date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase()

const formatDuration = (durationMs: number) => {
	if (durationMs >= 10_000) return `${Math.round(durationMs / 1000)}s`
	if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(1)}s`
	if (durationMs >= 100) return `${Math.round(durationMs)}ms`
	if (durationMs >= 10) return `${durationMs.toFixed(1)}ms`
	return `${durationMs.toFixed(2)}ms`
}

const relativeTime = (date: Date) => {
	const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
	return `${Math.floor(seconds / 86_400)}d`
}

const traceUiUrl = (traceId: string) => {
	const baseUrl = config.otel.queryUrl.endsWith("/") ? config.otel.queryUrl : `${config.otel.queryUrl}/`
	return new URL(`trace/${traceId}`, baseUrl).toString()
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

const copyToClipboard = async (value: string) => {
	const proc = Bun.spawn({
		cmd: ["pbcopy"],
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	})

	if (!proc.stdin) {
		throw new Error("Clipboard is not available")
	}

	proc.stdin.write(value)
	proc.stdin.end()

	const exitCode = await proc.exited
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(stderr.trim() || "Could not copy setup instructions")
	}
}

const traceIndicator = (trace: TraceItem) => (trace.errorCount > 0 ? "!" : "·")
const traceIndicatorColor = (trace: TraceItem) => (trace.errorCount > 0 ? colors.error : colors.passing)
const traceSpanColor = (span: TraceSpanItem) => (span.status === "error" ? colors.error : colors.text)
const traceRowId = (traceId: string) => `trace-row-${traceId}`
const G_PREFIX_TIMEOUT_MS = 500

const getTraceRowLayout = (contentWidth: number) => {
	const stateWidth = 1
	const durationWidth = 8
	const countWidth = 7
	const ageWidth = 6
	const titleWidth = Math.max(8, contentWidth - stateWidth - durationWidth - countWidth - ageWidth - 3)
	return { stateWidth, durationWidth, countWidth, ageWidth, titleWidth }
}

const TraceRow = ({
	trace,
	selected,
	contentWidth,
	onSelect,
}: {
	trace: TraceItem
	selected: boolean
	contentWidth: number
	onSelect: () => void
}) => {
	const { stateWidth, durationWidth, countWidth, ageWidth, titleWidth } = getTraceRowLayout(contentWidth)
	const title = `${trace.rootOperationName} #${trace.traceId.slice(-6)}`

	return (
		<box id={traceRowId(trace.traceId)} height={1} onMouseDown={onSelect}>
			<TextLine fg={selected ? colors.selectedText : colors.text} bg={selected ? colors.selectedBg : undefined}>
				<span fg={traceIndicatorColor(trace)}>{fitCell(traceIndicator(trace), stateWidth)}</span>
				<span> </span>
				<span>{fitCell(title, titleWidth)}</span>
				<span fg={selected ? colors.accent : colors.count}>{fitCell(formatDuration(trace.durationMs), durationWidth, "right")}</span>
				<span fg={colors.muted}>{fitCell(`${trace.spanCount}sp`, countWidth, "right")}</span>
				<span fg={colors.muted}>{fitCell(relativeTime(trace.startedAt), ageWidth, "right")}</span>
			</TextLine>
		</box>
	)
}

const TraceList = ({
	showHeader,
	traces,
	selectedTraceId,
	status,
	error,
	contentWidth,
	services,
	selectedService,
	onSelectTrace,
}: {
	showHeader: boolean
	traces: readonly TraceItem[]
	selectedTraceId: string | null
	status: LoadStatus
	error: string | null
	contentWidth: number
	services: readonly string[]
	selectedService: string | null
	onSelectTrace: (traceId: string) => void
}) => {
	if (showHeader) {
		return (
			<box flexDirection="column">
				<AlignedHeaderLine
					left="LOCAL TRACES"
					right={`service · ${selectedService ?? "waiting for traces"} (${services.length}) · ${config.otel.queryUrl}`}
					width={contentWidth}
				/>
			</box>
		)
	}

	return (
		<box flexDirection="column">
			{status === "loading" && traces.length === 0 ? <PlainLine text="- Loading traces..." fg={colors.muted} /> : null}
			{status === "error" ? <PlainLine text={`- ${error ?? "Could not load traces."}`} fg={colors.error} /> : null}
			{status === "ready" && services.length === 0 ? <PlainLine text="- No services yet. Start Jaeger or emit local spans, then refresh." fg={colors.muted} /> : null}
			{status === "ready" && selectedService && traces.length === 0 ? <PlainLine text="- No traces for the selected service in the current lookback window." fg={colors.muted} /> : null}
			{traces.map((trace) => (
				<TraceRow
					key={trace.traceId}
					trace={trace}
					selected={trace.traceId === selectedTraceId}
					contentWidth={contentWidth}
					onSelect={() => onSelectTrace(trace.traceId)}
				/>
			))}
		</box>
	)
}

const waterfallColors = {
	bar: "#f4a51c",
	barError: "#f97316",
	barBg: "#2a2520",
	barSelected: "#e8c547",
	barSelectedError: "#ff8c42",
} as const

const buildTreePrefix = (spans: readonly TraceSpanItem[], index: number): string => {
	const span = spans[index]
	if (span.depth === 0) return ""

	const parts: string[] = []

	const isLastChild = (spanIndex: number, depth: number): boolean => {
		for (let i = spanIndex + 1; i < spans.length; i++) {
			if (spans[i].depth < depth) return true
			if (spans[i].depth === depth) return false
		}
		return true
	}

	parts.push(isLastChild(index, span.depth) ? "└─" : "├─")

	for (let d = span.depth - 1; d >= 1; d--) {
		let parentIndex = index
		for (let i = index - 1; i >= 0; i--) {
			if (spans[i].depth === d) {
				parentIndex = i
				break
			}
			if (spans[i].depth < d) break
		}
		parts.push(isLastChild(parentIndex, d) ? "  " : "│ ")
	}

	return parts.reverse().join("")
}

const renderWaterfallBar = (span: TraceSpanItem, trace: TraceItem, barWidth: number): { before: string; bar: string; after: string; barStart: number; barEnd: number } => {
	if (barWidth < 3 || trace.durationMs === 0) {
		return { before: "", bar: "█", after: "", barStart: 0, barEnd: 1 }
	}

	const traceStart = trace.startedAt.getTime()
	const spanStart = span.startTime.getTime()
	const relativeStart = Math.max(0, spanStart - traceStart)
	const startFrac = relativeStart / trace.durationMs
	const widthFrac = Math.max(0.01, span.durationMs / trace.durationMs)

	const barStart = Math.min(Math.round(startFrac * barWidth), barWidth - 1)
	const barLen = Math.max(1, Math.round(widthFrac * barWidth))
	const barEnd = Math.min(barWidth, barStart + barLen)
	const barChars = Math.max(1, barEnd - barStart)
	const afterLen = Math.max(0, barWidth - barStart - barChars)

	return {
		before: "·".repeat(barStart),
		bar: "█".repeat(barChars),
		after: "·".repeat(afterLen),
		barStart,
		barEnd,
	}
}

const WaterfallRow = ({
	span,
	trace,
	index,
	spans,
	contentWidth,
	selected,
	onSelect,
}: {
	span: TraceSpanItem
	trace: TraceItem
	index: number
	spans: readonly TraceSpanItem[]
	contentWidth: number
	selected: boolean
	onSelect: () => void
}) => {
	const prefix = buildTreePrefix(spans, index)
	const indicator = span.status === "error" ? "!" : "·"
	const opName = span.operationName
	const duration = formatDuration(span.durationMs)

	const labelMaxWidth = Math.min(Math.floor(contentWidth * 0.4), 32)
	const durationWidth = duration.length + 1
	const barWidth = Math.max(6, contentWidth - labelMaxWidth - durationWidth - 2)

	const opMaxWidth = Math.max(4, labelMaxWidth - prefix.length - 2)
	const opTruncated = opName.length > opMaxWidth ? `${opName.slice(0, opMaxWidth - 1)}…` : opName
	const labelLen = prefix.length + 2 + opTruncated.length
	const labelPad = " ".repeat(Math.max(0, labelMaxWidth - labelLen))

	const { before, bar, after } = renderWaterfallBar(span, trace, barWidth)
	const isError = span.status === "error"
	const barColor = selected ? (isError ? waterfallColors.barSelectedError : waterfallColors.barSelected) : isError ? waterfallColors.barError : waterfallColors.bar
	const bg = selected ? colors.selectedBg : undefined
	const treeColor = selected ? colors.separator : "#524d45"
	const indicatorColor = isError ? colors.error : selected ? colors.passing : colors.muted
	const opColor = selected ? colors.selectedText : colors.text

	return (
		<box height={1} onMouseDown={onSelect}>
			<TextLine bg={bg}>
				{prefix ? <span fg={treeColor}>{prefix}</span> : null}
				<span fg={indicatorColor}>{indicator}</span>
				<span fg={opColor}>{` ${opTruncated}`}</span>
				<span>{labelPad}</span>
				<span> </span>
				<span fg={waterfallColors.barBg}>{before}</span>
				<span fg={barColor}>{bar}</span>
				<span fg={waterfallColors.barBg}>{after}</span>
				<span> </span>
				<span fg={selected ? colors.accent : colors.count}>{duration}</span>
			</TextLine>
		</box>
	)
}

const INTERESTING_TAGS = [
	"http.method", "http.url", "http.status_code", "http.route",
	"db.system", "db.statement", "db.name",
	"messaging.system", "messaging.destination",
	"error", "error.message",
	"net.peer.name", "net.peer.port",
] as const

const spanPreviewEntries = (span: TraceSpanItem, maxEntries: number): Array<{ key: string; value: string; isWarning?: boolean }> => {
	const entries = Object.entries(span.tags)
	const interesting = entries.filter(([key]) =>
		INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) || key.startsWith("error"),
	)
	const rest = entries.filter(([key]) =>
		!INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) && !key.startsWith("error") && !key.startsWith("otel.") && key !== "span.kind",
	)
	const tagResults: Array<{ key: string; value: string; isWarning?: boolean }> = [...interesting, ...rest]
		.slice(0, maxEntries - span.warnings.length)
		.map(([key, value]) => ({ key, value }))
	for (const warning of span.warnings) {
		tagResults.push({ key: "warning", value: warning, isWarning: true })
	}
	return tagResults.slice(0, maxEntries)
}

const SpanPreview = ({
	span,
	contentWidth,
	maxLines,
}: {
	span: TraceSpanItem
	contentWidth: number
	maxLines: number
}) => {
	const entries = spanPreviewEntries(span, maxLines)
	if (entries.length === 0) return null

	const maxKeyLen = Math.min(22, entries.reduce((max, e) => Math.max(max, e.key.length), 0))
	const valMaxWidth = Math.max(8, contentWidth - maxKeyLen - 3)
	const indent = " ".repeat(maxKeyLen + 2)

	const lines: Array<{ keyPart: string; valPart: string; isWarning?: boolean }> = []
	for (const entry of entries) {
		const keyStr = entry.key.length > maxKeyLen ? `${entry.key.slice(0, maxKeyLen - 1)}…` : entry.key.padEnd(maxKeyLen)
		const val = entry.value
		if (val.length <= valMaxWidth) {
			lines.push({ keyPart: keyStr, valPart: val, isWarning: entry.isWarning })
		} else {
			let remaining = val
			let first = true
			while (remaining.length > 0) {
				const chunk = remaining.slice(0, valMaxWidth)
				remaining = remaining.slice(valMaxWidth)
				lines.push({ keyPart: first ? keyStr : indent, valPart: chunk, isWarning: entry.isWarning })
				first = false
			}
		}
	}

	return (
		<box flexDirection="column">
			{lines.slice(0, maxLines).map((line, i) => (
				<TextLine key={`preview-${i}`}>
					<span fg={line.isWarning ? colors.error : "#6a6358"}>{line.keyPart}</span>
					<span fg={colors.separator}>  </span>
					<span fg={line.isWarning ? colors.error : colors.muted}>{line.valPart}</span>
				</TextLine>
			))}
		</box>
	)
}

const WaterfallTimeline = ({
	trace,
	contentWidth,
	bodyLines,
	selectedSpanIndex,
	onSelectSpan,
}: {
	trace: TraceItem
	contentWidth: number
	bodyLines: number
	selectedSpanIndex: number | null
	onSelectSpan: (index: number) => void
}) => {
	const selectedSpan = selectedSpanIndex !== null ? trace.spans[selectedSpanIndex] ?? null : null
	const previewTagCount = selectedSpan ? spanPreviewEntries(selectedSpan, 99).length : 0
	const previewLines = selectedSpan ? Math.min(Math.max(previewTagCount, 1), Math.max(2, Math.floor(bodyLines * 0.4))) : 0
	const waterfallLines = bodyLines - 1 - previewLines

	const labelMaxWidth = Math.min(Math.floor(contentWidth * 0.4), 32)
	const durationWidth = 8
	const barWidth = Math.max(6, contentWidth - labelMaxWidth - durationWidth - 2)
	const midDuration = formatDuration(trace.durationMs / 2)
	const endDuration = formatDuration(trace.durationMs)

	const rulerLabel = " ".repeat(labelMaxWidth + 1)
	const rulerTotalWidth = barWidth + 1 + durationWidth
	const midPoint = Math.floor(barWidth / 2)
	const rulerBar = `${"0".padEnd(midPoint)}${midDuration.padEnd(barWidth - midPoint)}${endDuration.padStart(durationWidth)}`

	const spanWindowSize = Math.max(1, waterfallLines)
	const windowStart = selectedSpanIndex === null
		? 0
		: Math.max(0, Math.min(selectedSpanIndex - Math.floor(spanWindowSize / 2), trace.spans.length - spanWindowSize))
	const visibleSpans = trace.spans.slice(windowStart, windowStart + spanWindowSize)
	const blankCount = Math.max(0, spanWindowSize - visibleSpans.length)

	const remainingBlanks = Math.max(0, blankCount - (selectedSpan ? 0 : previewLines))

	return (
		<box flexDirection="column">
			<TextLine fg={colors.muted}>
				<span>{rulerLabel}</span>
				<span>{rulerBar}</span>
			</TextLine>
			{visibleSpans.map((span, index) => {
				const actualIndex = windowStart + index

				return (
				<WaterfallRow
					key={`${trace.traceId}-${span.spanId}`}
					span={span}
					trace={trace}
					index={actualIndex}
					spans={trace.spans}
					contentWidth={contentWidth}
					selected={selectedSpanIndex === actualIndex}
					onSelect={() => onSelectSpan(actualIndex)}
				/>
				)
			})}
			{Array.from({ length: remainingBlanks }, (_, i) => (
				<BlankRow key={`blank-${i}`} />
			))}
		</box>
	)
}

const SpanDetailView = ({
	span,
	contentWidth,
	bodyLines,
}: {
	span: TraceSpanItem
	contentWidth: number
	bodyLines: number
}) => {
	const tagEntries = Object.entries(span.tags)
	const maxKeyLen = Math.min(28, tagEntries.reduce((max, [key]) => Math.max(max, key.length), 0))
	const maxLines = bodyLines - 4

	return (
		<box flexDirection="column">
			<TextLine>
				<span fg={colors.text}>{span.operationName}</span>
			</TextLine>
			<TextLine>
				<span fg={colors.defaultService}>{span.serviceName}</span>
				<span fg={colors.separator}>{SEPARATOR}</span>
				<span fg={colors.count}>{formatDuration(span.durationMs)}</span>
				<span fg={colors.separator}>{SEPARATOR}</span>
				<span fg={span.status === "error" ? colors.error : colors.passing}>{span.status}</span>
			</TextLine>
			<BlankRow />
			{tagEntries.length > 0 ? (
				<>
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>TAGS</span>
					</TextLine>
					{tagEntries.slice(0, maxLines).map(([key, value]) => {
						const keyStr = key.length > maxKeyLen ? `${key.slice(0, maxKeyLen - 1)}…` : key.padEnd(maxKeyLen)
						const valMaxWidth = Math.max(8, contentWidth - maxKeyLen - 2)
						const valStr = value.length > valMaxWidth ? `${value.slice(0, valMaxWidth - 1)}…` : value

						return (
							<TextLine key={key}>
								<span fg={colors.count}>{keyStr}</span>
								<span fg={colors.muted}>  </span>
								<span fg={colors.text}>{valStr}</span>
							</TextLine>
						)
					})}
					{tagEntries.length > maxLines ? (
						<PlainLine text={`  … ${tagEntries.length - maxLines} more`} fg={colors.muted} />
					) : null}
				</>
			) : (
				<PlainLine text="No tags on this span." fg={colors.muted} />
			)}
			{span.warnings.length > 0 ? (
				<>
					<BlankRow />
					<TextLine>
						<span fg={colors.accent} attributes={TextAttributes.BOLD}>WARNINGS</span>
					</TextLine>
					{span.warnings.map((warning, i) => (
						<PlainLine key={i} text={warning} fg={colors.error} />
					))}
				</>
			) : null}
		</box>
	)
}

const TraceDetailsPane = ({
	trace,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedSpanIndex,
	detailView,
	onSelectSpan,
}: {
	trace: TraceItem | null
	contentWidth: number
	bodyLines: number
	paneWidth: number
	selectedSpanIndex: number | null
	detailView: DetailView
	onSelectSpan: (index: number) => void
}) => {
	const selectedSpan = trace && selectedSpanIndex !== null ? trace.spans[selectedSpanIndex] ?? null : null
	const detailHeaderTitle = detailView === "span-detail" && selectedSpan ? "SPAN DETAIL" : "TRACE DETAILS"
	const detailHeaderRight = detailView === "span-detail" && selectedSpan
		? `${selectedSpan.status} · ${formatDuration(selectedSpan.durationMs)}`
		: trace
			? `${trace.errorCount > 0 ? `${trace.errorCount} errors` : "healthy"} · ${formatDuration(trace.durationMs)}`
			: "waiting for trace"
	const detailHeaderColor = detailView === "span-detail" && selectedSpan
		? selectedSpan.status === "error"
			? colors.error
			: colors.passing
		: trace && trace.errorCount > 0
			? colors.error
			: colors.passing

	return (
		<box flexDirection="column" height={bodyLines + 5}>
			<box paddingLeft={1} paddingRight={1}>
				<AlignedHeaderLine left={detailHeaderTitle} right={detailHeaderRight} width={contentWidth} rightFg={detailHeaderColor} />
			</box>
			{trace ? (
				<>
					{detailView === "span-detail" && selectedSpan ? (
						<box flexDirection="column" paddingLeft={1} paddingRight={1}>
							<SpanDetailView span={selectedSpan} contentWidth={contentWidth} bodyLines={bodyLines + 2} />
						</box>
					) : (
						<>
							<box flexDirection="column" paddingLeft={1} paddingRight={1}>
								<TextLine>
									<span>{trace.rootOperationName}</span>
								</TextLine>
								{(() => {
									const left = `${trace.serviceName}${SEPARATOR}${trace.spanCount} spans`
									const dateStr = `${formatShortDate(trace.startedAt)} ${formatTimestamp(trace.startedAt)}`
									const gap = Math.max(2, contentWidth - left.length - dateStr.length)
									return (
										<TextLine>
											<span fg={colors.defaultService}>{trace.serviceName}</span>
											<span fg={colors.separator}>{SEPARATOR}</span>
											<span fg={colors.count}>{trace.spanCount} spans</span>
											<span>{" ".repeat(gap)}</span>
											<span fg={colors.muted}>{dateStr}</span>
										</TextLine>
									)
								})()}
								{trace.warnings.length > 0 ? (
									<PlainLine text={trace.warnings.join(" | ")} fg={colors.error} />
								) : (
									<PlainLine text={`${trace.traceId.slice(0, 16)}  ${traceUiUrl(trace.traceId)}`} fg={colors.muted} />
								)}
							</box>
							<Divider width={paneWidth} />
							<box flexDirection="column" paddingLeft={1} paddingRight={1}>
								<WaterfallTimeline
									trace={trace}
									contentWidth={contentWidth}
									bodyLines={bodyLines}
									selectedSpanIndex={selectedSpanIndex}
									onSelectSpan={onSelectSpan}
								/>
							</box>
							{selectedSpan ? (
								<>
									<Divider width={paneWidth} />
									<box flexDirection="column" paddingLeft={1} paddingRight={1}>
										<SpanPreview span={selectedSpan} contentWidth={contentWidth} maxLines={Math.min(spanPreviewEntries(selectedSpan, 99).length, Math.max(2, Math.floor(bodyLines * 0.4)))} />
									</box>
								</>
							) : null}
						</>
					)}
				</>
			) : (
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<PlainLine text="Select a trace with up/down." fg={colors.muted} />
					{Array.from({ length: bodyLines + 2 }, (_, index) => (
						<BlankRow key={index} />
					))}
				</box>
			)}
		</box>
	)
}

export const App = () => {
	const { width, height } = useTerminalDimensions()
	const [traceState, setTraceState] = useAtom(traceStateAtom)
	const [selectedTraceIndex, setSelectedTraceIndex] = useAtom(selectedTraceIndexAtom)
	const [selectedTraceService, setSelectedTraceService] = useAtom(selectedTraceServiceAtom)
	const [refreshNonce, setRefreshNonce] = useAtom(refreshNonceAtom)
	const [notice, setNotice] = useAtom(noticeAtom)
	const [selectedSpanIndex, setSelectedSpanIndex] = useAtom(selectedSpanIndexAtom)
	const [detailView, setDetailView] = useAtom(detailViewAtom)
	const [showHelp, setShowHelp] = useAtom(showHelpAtom)
	const footerNotice = notice ? fitCell(notice, Math.max(24, Math.max(60, width ?? 100) - 2)) : null
	const contentWidth = Math.max(60, width ?? 100)
	const isWideLayout = (width ?? 100) >= 140
	const splitGap = 1
	const sectionPadding = 1
	const traceListHeaderHeight = 1
	const footerHeight = footerNotice ? 1 : showHelp ? 2 : 0
	const footerFrameHeight = footerHeight > 0 ? 1 + footerHeight : 0
	const frameHeight = 1 + 1 + footerFrameHeight
	const availableContentHeight = Math.max(10, (height ?? 24) - frameHeight)
	const leftPaneWidth = isWideLayout ? Math.max(44, Math.floor((contentWidth - splitGap) * 0.56)) : contentWidth
	const rightPaneWidth = isWideLayout ? Math.max(28, contentWidth - leftPaneWidth - splitGap) : contentWidth
	const dividerJunctionAt = Math.max(1, leftPaneWidth)
	const leftContentWidth = isWideLayout ? Math.max(24, leftPaneWidth - 3) : Math.max(24, contentWidth - sectionPadding * 2)
	const rightContentWidth = isWideLayout ? Math.max(24, rightPaneWidth - sectionPadding * 2) : Math.max(24, contentWidth - sectionPadding * 2)
	const headerFooterWidth = Math.max(24, contentWidth - 2)
	const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const traceListScrollRef = useRef<ScrollBoxRenderable | null>(null)
	const pendingGRef = useRef(false)
	const pendingGTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const flashNotice = (message: string) => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}

		setNotice(message)
		noticeTimeoutRef.current = globalThis.setTimeout(() => {
			setNotice((current) => (current === message ? null : current))
		}, 2500)
	}

	useEffect(() => () => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}
		if (pendingGTimeoutRef.current !== null) {
			clearTimeout(pendingGTimeoutRef.current)
		}
	}, [])

	useEffect(() => {
		let cancelled = false

		const load = async () => {
			setTraceState((current) => ({
				...current,
				status: current.fetchedAt === null ? "loading" : "ready",
				error: null,
			}))

			try {
				const services = await loadTraceServices()
				if (cancelled) return

				const effectiveService = services.includes(selectedTraceService ?? "")
					? selectedTraceService
					: selectedTraceService ?? services[0] ?? config.otel.serviceName

				if (effectiveService !== selectedTraceService) {
					setSelectedTraceService(effectiveService)
				}

				const traces = effectiveService ? await loadRecentTraces(effectiveService) : []
				if (cancelled) return

				setTraceState({
					status: "ready",
					services,
					data: traces,
					error: null,
					fetchedAt: new Date(),
				})
			} catch (error) {
				if (cancelled) return
				setTraceState((current) => ({
					...current,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				}))
			}
		}

		void load()

		return () => {
			cancelled = true
		}
	}, [refreshNonce, selectedTraceService])

	useEffect(() => {
		setSelectedTraceIndex((current) => {
			if (traceState.data.length === 0) return 0
			return Math.max(0, Math.min(current, traceState.data.length - 1))
		})
	}, [traceState.data.length])

	const selectedTrace = traceState.data[selectedTraceIndex] ?? null

	useEffect(() => {
		if (selectedSpanIndex === null) return
		if (!selectedTrace || selectedTrace.spans.length === 0) {
			setSelectedSpanIndex(null)
			setDetailView("waterfall")
			return
		}
		if (selectedSpanIndex >= selectedTrace.spans.length) {
			setSelectedSpanIndex(selectedTrace.spans.length - 1)
		}
	}, [selectedTrace, selectedSpanIndex, setSelectedSpanIndex, setDetailView])

	useEffect(() => {
		const selectedTraceId = traceState.data[selectedTraceIndex]?.traceId
		if (!selectedTraceId) return

		traceListScrollRef.current?.scrollChildIntoView(traceRowId(selectedTraceId))
	}, [selectedTraceIndex, traceState.data, selectedTraceService, isWideLayout])
	const headerLeft = `LETO OTEL  service: ${selectedTraceService ?? "none"}`
	const headerRight = traceState.fetchedAt
		? `updated ${formatShortDate(traceState.fetchedAt)} ${formatTimestamp(traceState.fetchedAt)}`
		: traceState.status === "loading"
			? "loading traces..."
			: ""
	const headerLine = `${fitCell(headerLeft, Math.max(0, headerFooterWidth - headerRight.length))}${headerRight}`
	const visibleFooterNotice = footerNotice ? fitCell(footerNotice.trimEnd(), headerFooterWidth) : null
	const wideBodyHeight = availableContentHeight
	const wideBodyLines = Math.max(8, Math.min(16, wideBodyHeight - 7))
	const narrowSplitHeight = Math.max(10, availableContentHeight - 1)
	const narrowListHeight = Math.max(4, Math.min(10, Math.floor(narrowSplitHeight * 0.4), narrowSplitHeight - 9))
	const narrowDetailHeight = narrowSplitHeight - narrowListHeight
	const narrowBodyLines = Math.max(2, narrowDetailHeight - 7)
	const wideTraceListBodyHeight = Math.max(1, wideBodyHeight - traceListHeaderHeight)
	const narrowTraceListBodyHeight = Math.max(1, narrowListHeight - traceListHeaderHeight)
	const traceViewportRows = isWideLayout ? wideTraceListBodyHeight : narrowTraceListBodyHeight
	const tracePageSize = Math.max(1, traceViewportRows - 1)
	const spanViewportRows = Math.max(1, (isWideLayout ? wideBodyLines : narrowBodyLines) - 1)
	const spanPageSize = Math.max(1, spanViewportRows - 1)

	const refresh = (message?: string) => {
		setRefreshNonce((current) => current + 1)
		if (message) flashNotice(message)
	}

	const cycleService = (direction: -1 | 1) => {
		if (traceState.services.length === 0) return
		const currentIndex = selectedTraceService ? traceState.services.indexOf(selectedTraceService) : -1
		const nextIndex = currentIndex >= 0 ? (currentIndex + direction + traceState.services.length) % traceState.services.length : 0
		setSelectedTraceService(traceState.services[nextIndex] ?? selectedTraceService)
	}

	const selectTraceById = (traceId: string) => {
		const index = traceState.data.findIndex((trace) => trace.traceId === traceId)
		if (index >= 0) setSelectedTraceIndex(index)
	}

	const moveTraceBy = (direction: -1 | 1) => {
		setSelectedTraceIndex((current) => {
			if (traceState.data.length === 0) return 0
			return direction < 0
				? current <= 0 ? traceState.data.length - 1 : current - 1
				: current >= traceState.data.length - 1 ? 0 : current + 1
		})
	}

	const spanNavActive = selectedSpanIndex !== null

	const clearPendingG = () => {
		pendingGRef.current = false
		if (pendingGTimeoutRef.current !== null) {
			clearTimeout(pendingGTimeoutRef.current)
			pendingGTimeoutRef.current = null
		}
	}

	const armPendingG = () => {
		clearPendingG()
		pendingGRef.current = true
		pendingGTimeoutRef.current = globalThis.setTimeout(() => {
			pendingGRef.current = false
			pendingGTimeoutRef.current = null
		}, G_PREFIX_TIMEOUT_MS)
	}

	const jumpToStart = () => {
		if (spanNavActive && selectedTrace) {
			setSelectedSpanIndex(selectedTrace.spans.length === 0 ? null : 0)
		} else {
			setSelectedTraceIndex(0)
		}
	}

	const jumpToEnd = () => {
		if (spanNavActive && selectedTrace) {
			setSelectedSpanIndex(selectedTrace.spans.length === 0 ? null : selectedTrace.spans.length - 1)
		} else {
			setSelectedTraceIndex(traceState.data.length === 0 ? 0 : traceState.data.length - 1)
		}
	}

	const pageBy = (direction: -1 | 1) => {
		if (spanNavActive && selectedTrace) {
			setSelectedSpanIndex((current) => {
				if (selectedTrace.spans.length === 0) return null
				const start = current ?? 0
				return Math.max(0, Math.min(start + direction * spanPageSize, selectedTrace.spans.length - 1))
			})
		} else {
			setSelectedTraceIndex((current) => {
				if (traceState.data.length === 0) return 0
				return Math.max(0, Math.min(current + direction * tracePageSize, traceState.data.length - 1))
			})
		}
	}

	const selectSpan = (index: number) => {
		if (!selectedTrace) return
		setSelectedSpanIndex(Math.max(0, Math.min(index, selectedTrace.spans.length - 1)))
	}

	useKeyboard((key) => {
		const plainG = key.name === "g" && !key.ctrl && !key.meta && !key.option && !key.shift
		const shiftedG = key.name === "g" && key.shift
		const questionMark = key.name === "?" || (key.name === "/" && key.shift)

		if (questionMark) {
			clearPendingG()
			setShowHelp((current) => !current)
			return
		}

		if (plainG && !key.repeated) {
			if (pendingGRef.current) {
				clearPendingG()
				jumpToStart()
			} else {
				armPendingG()
			}
			return
		}

		if (shiftedG) {
			clearPendingG()
			jumpToEnd()
			return
		}

		clearPendingG()

		if (key.name === "q" || (key.ctrl && key.name === "c")) {
			process.exit(0)
		}
		if (key.name === "home") {
			jumpToStart()
			return
		}
		if (key.name === "end") {
			jumpToEnd()
			return
		}
		if (key.name === "pagedown" || (key.ctrl && key.name === "d")) {
			pageBy(1)
			return
		}
		if (key.name === "pageup" || (key.ctrl && key.name === "u")) {
			pageBy(-1)
			return
		}
		if (key.ctrl && key.name === "p") {
			moveTraceBy(-1)
			return
		}
		if (key.ctrl && key.name === "n") {
			moveTraceBy(1)
			return
		}
		if (key.name === "escape") {
			if (showHelp) {
				setShowHelp(false)
				return
			}
			if (detailView === "span-detail") {
				setDetailView("waterfall")
				return
			}
			if (spanNavActive) {
				setSelectedSpanIndex(null)
				return
			}
			return
		}
		if (key.name === "return" || key.name === "enter") {
			if (spanNavActive && detailView === "waterfall") {
				setDetailView("span-detail")
				return
			}
			if (!spanNavActive && selectedTrace && selectedTrace.spans.length > 0) {
				setSelectedSpanIndex(0)
				return
			}
			return
		}
		if (key.name === "r") {
			refresh("Refreshing traces...")
			return
		}
		if (key.name === "[") {
			cycleService(-1)
			return
		}
		if (key.name === "]") {
			cycleService(1)
			return
		}
		if (key.name === "up" || key.name === "k") {
			if (spanNavActive && selectedTrace) {
				setSelectedSpanIndex((current) => {
					if (current === null || selectedTrace.spans.length === 0) return 0
					return current <= 0 ? selectedTrace.spans.length - 1 : current - 1
				})
			} else {
				moveTraceBy(-1)
			}
			return
		}
		if (key.name === "down" || key.name === "j") {
			if (spanNavActive && selectedTrace) {
				setSelectedSpanIndex((current) => {
					if (current === null || selectedTrace.spans.length === 0) return 0
					return current >= selectedTrace.spans.length - 1 ? 0 : current + 1
				})
			} else {
				moveTraceBy(1)
			}
			return
		}
		if (key.name === "o" && selectedTrace) {
			void Bun.spawn({ cmd: ["open", traceUiUrl(selectedTrace.traceId)], stdout: "ignore", stderr: "ignore" })
			flashNotice(`Opened trace ${selectedTrace.traceId.slice(-8)}`)
			return
		}
		if (key.name === "c" || key.name === "C") {
			void copyToClipboard(effectSetupInstructions())
				.then(() => {
					flashNotice("Copied Effect setup instructions")
				})
				.catch((error) => {
					flashNotice(error instanceof Error ? error.message : String(error))
				})
		}
	})

	return (
		<box flexGrow={1} flexDirection="column">
			<box paddingLeft={1} paddingRight={1} flexDirection="column">
				<PlainLine text={headerLine} fg={colors.muted} bold />
			</box>
			{isWideLayout ? <Divider width={contentWidth} junctionAt={dividerJunctionAt} junctionChar="┬" /> : <Divider width={contentWidth} />}
			{isWideLayout ? (
				<box flexGrow={1} flexDirection="row">
					<box width={leftPaneWidth} height={wideBodyHeight} flexDirection="column" paddingLeft={sectionPadding} paddingRight={sectionPadding}>
						<TraceList
							showHeader
							traces={traceState.data}
							selectedTraceId={selectedTrace?.traceId ?? null}
							status={traceState.status}
							error={traceState.error}
							contentWidth={leftContentWidth}
							services={traceState.services}
							selectedService={selectedTraceService}
							onSelectTrace={selectTraceById}
						/>
						<scrollbox ref={traceListScrollRef} height={wideTraceListBodyHeight} flexGrow={0}>
							<TraceList
								showHeader={false}
								traces={traceState.data}
								selectedTraceId={selectedTrace?.traceId ?? null}
								status={traceState.status}
								error={traceState.error}
								contentWidth={leftContentWidth}
								services={traceState.services}
								selectedService={selectedTraceService}
								onSelectTrace={selectTraceById}
							/>
						</scrollbox>
					</box>
					<SeparatorColumn height={wideBodyHeight} junctionRow={DETAIL_DIVIDER_ROW} />
					<box width={rightPaneWidth} height={wideBodyHeight} flexDirection="column">
						<scrollbox height={wideBodyHeight} flexGrow={0}>
							<TraceDetailsPane trace={selectedTrace} contentWidth={rightContentWidth} bodyLines={wideBodyLines} paneWidth={rightPaneWidth} selectedSpanIndex={selectedSpanIndex} detailView={detailView} onSelectSpan={selectSpan} />
						</scrollbox>
					</box>
				</box>
			) : (
				<>
					<TraceDetailsPane trace={selectedTrace} contentWidth={rightContentWidth} bodyLines={narrowBodyLines} paneWidth={contentWidth} selectedSpanIndex={selectedSpanIndex} detailView={detailView} onSelectSpan={selectSpan} />
					<Divider width={contentWidth} />
					<box height={narrowListHeight} flexDirection="column" paddingLeft={sectionPadding} paddingRight={sectionPadding}>
						<TraceList
							showHeader
							traces={traceState.data}
							selectedTraceId={selectedTrace?.traceId ?? null}
							status={traceState.status}
							error={traceState.error}
							contentWidth={leftContentWidth}
							services={traceState.services}
							selectedService={selectedTraceService}
							onSelectTrace={selectTraceById}
						/>
						<scrollbox ref={traceListScrollRef} height={narrowTraceListBodyHeight} flexGrow={0}>
							<TraceList
								showHeader={false}
								traces={traceState.data}
								selectedTraceId={selectedTrace?.traceId ?? null}
								status={traceState.status}
								error={traceState.error}
								contentWidth={leftContentWidth}
								services={traceState.services}
								selectedService={selectedTraceService}
								onSelectTrace={selectTraceById}
							/>
						</scrollbox>
					</box>
				</>
			)}
			{footerHeight > 0 ? (
				<>
					{isWideLayout ? <Divider width={contentWidth} junctionAt={dividerJunctionAt} junctionChar="┴" /> : <Divider width={contentWidth} />}
					<box paddingLeft={1} paddingRight={1} flexDirection="column" height={footerHeight}>
						{visibleFooterNotice ? (
							<PlainLine text={visibleFooterNotice} fg={colors.count} />
						) : (
							<FooterHints spanNavActive={spanNavActive} detailView={detailView} width={headerFooterWidth} />
						)}
					</box>
				</>
			) : null}
		</box>
	)
}
