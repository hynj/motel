import { useMemo } from "react"
import type { TraceItem } from "../domain.ts"
import { formatDuration, formatShortDate, formatTimestamp, lifecycleLabel } from "./format.ts"
import { AlignedHeaderLine, BlankRow, Divider, PlainLine, SeparatorColumn, TextLine } from "./primitives.tsx"
import { SpanDetailView } from "./SpanDetail.tsx"
import { getVisibleSpans, SpanPreview, spanPreviewEntries, WaterfallTimeline } from "./Waterfall.tsx"
import type { DetailView, LogState } from "./state.ts"
import { colors, SEPARATOR } from "./theme.ts"
export const TraceDetailsPane = ({
	trace,
	traceLogsState,
	contentWidth,
	bodyLines,
	paneWidth,
	selectedSpanIndex,
	collapsedSpanIds,
	detailView,
	focused = false,
	onSelectSpan,
}: {
	trace: TraceItem | null
	traceLogsState: LogState
	contentWidth: number
	bodyLines: number
	paneWidth: number
	selectedSpanIndex: number | null
	collapsedSpanIds: ReadonlySet<string>
	detailView: DetailView
	focused?: boolean
	onSelectSpan: (index: number) => void
}) => {
	const filteredSpans = useMemo(
		() => trace ? getVisibleSpans(trace.spans, collapsedSpanIds) : [],
		[trace, collapsedSpanIds],
	)
	const selectedSpan = selectedSpanIndex !== null ? filteredSpans[selectedSpanIndex] ?? null : null
	const traceLogCount = traceLogsState.data.length
	const spanLogCounts = useMemo(() => {
		const counts = new Map<string, number>()
		for (const log of traceLogsState.data) {
			if (!log.spanId) continue
			counts.set(log.spanId, (counts.get(log.spanId) ?? 0) + 1)
		}
		return counts
	}, [traceLogsState.data])
	const selectedSpanLogs = useMemo(
		() => selectedSpan ? traceLogsState.data.filter((log) => log.spanId === selectedSpan.spanId) : [],
		[selectedSpan, traceLogsState.data],
	)
	const focusIndicator = focused ? "\u25b8 " : ""
	const detailHeaderTitle = detailView === "span-detail" && selectedSpan
		? `${focusIndicator}SPAN DETAIL`
			: `${focusIndicator}TRACE DETAILS`
	// Right-aligned header meta. Avoid duplicating `lifecycleLabel` (which we also
	// show on the row beneath the op name). Pick the most important signals:
	// status (errors / healthy / running), duration, logs.
	const detailHeaderRight = detailView === "span-detail" && selectedSpan
		? `${selectedSpan.status} \u00b7 ${formatDuration(selectedSpan.durationMs)}${selectedSpanLogs.length > 0 ? ` \u00b7 ${selectedSpanLogs.length} logs` : ""}`
		: trace
			? `${trace.errorCount > 0 ? `${trace.errorCount} errors` : trace.isRunning ? "running" : "healthy"} \u00b7 ${formatDuration(trace.durationMs)}${traceLogCount > 0 ? ` \u00b7 ${traceLogCount} logs` : ""}`
			: "waiting for trace"
	const detailHeaderColor = detailView === "span-detail" && selectedSpan
		? selectedSpan.isRunning
			? colors.warning
			: selectedSpan.status === "error"
			? colors.error
			: colors.passing
		: trace?.isRunning
			? colors.warning
			: trace && trace.errorCount > 0
			? colors.error
			: colors.passing

	// Header section: 1 (header) + 2 (info lines) + 1 (divider) = 4 rows.
	// Warnings share the traceId/meta line as a compact badge when present.
	const headerRows = 4

	// When a span is selected and the pane is wide enough, show waterfall on the
	// left and span preview/detail on the right instead of stacking vertically.
	const showSideBySide = selectedSpan !== null && paneWidth >= 100
	const splitLeftWidth = showSideBySide ? Math.max(30, Math.floor(paneWidth * 0.45)) : 0
	const splitRightWidth = showSideBySide ? paneWidth - splitLeftWidth - 1 : 0
	const splitContentLeft = Math.max(20, splitLeftWidth - 2)
	const splitContentRight = Math.max(20, splitRightWidth - 2)

	// When side-by-side, waterfall gets the full body height (no bottom preview)
	// When stacked, reserve space for the preview at the bottom
	const maxPreviewAllocation = Math.min(8, Math.max(2, Math.floor(bodyLines * 0.2)))
	const previewReserved = !showSideBySide && selectedSpanIndex !== null ? maxPreviewAllocation + 1 : 0
	const previewMaxLines = selectedSpan ? Math.min(spanPreviewEntries(selectedSpan, selectedSpanLogs, 99).length, maxPreviewAllocation) : 0
	const waterfallBodyLines = Math.max(4, bodyLines - previewReserved)

	// Date string for the operation row
	const dateStr = trace ? `${formatShortDate(trace.startedAt)} ${formatTimestamp(trace.startedAt)}` : ""
	const opLeft = trace?.rootOperationName ?? ""
	const opGap = Math.max(2, contentWidth - opLeft.length - dateStr.length)
	// Warnings badge — truncate the first one; tooltip-style full text hidden
	const warningCount = trace?.warnings.length ?? 0
	const firstWarning = trace?.warnings[0] ?? ""

	return (
		<box flexDirection="column" height={bodyLines + headerRows}>
			<box paddingLeft={1}>
				<AlignedHeaderLine left={detailHeaderTitle} right={detailHeaderRight} width={contentWidth} rightFg={detailHeaderColor} />
			</box>
		{trace ? (
			<>
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					{/* Row 1: operation name + timestamp on the right */}
					<TextLine>
						<span>{opLeft}</span>
						<span>{" ".repeat(opGap)}</span>
						<span fg={colors.muted}>{dateStr}</span>
					</TextLine>
					{/* Row 2: service · span count + warnings badge OR trace id */}
					{warningCount > 0 ? (
						<TextLine>
							<span fg={colors.defaultService}>{trace.serviceName}</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.count}>{trace.spanCount} spans</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.error}>{warningCount} warning{warningCount === 1 ? "" : "s"}: {firstWarning}</span>
						</TextLine>
					) : (
						<TextLine>
							<span fg={colors.defaultService}>{trace.serviceName}</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.count}>{trace.spanCount} spans</span>
							<span fg={colors.separator}>{SEPARATOR}</span>
							<span fg={colors.muted}>{trace.traceId.slice(0, 16)}</span>
						</TextLine>
					)}
				</box>
				<Divider width={paneWidth} />
				{showSideBySide && selectedSpan ? (
					<box flexDirection="row" flexGrow={1}>
						<box width={splitLeftWidth} flexDirection="column" paddingLeft={1} paddingRight={1}>
							<WaterfallTimeline
								trace={trace}
								filteredSpans={filteredSpans}
								spanLogCounts={spanLogCounts}
								selectedSpanLogs={selectedSpanLogs}
								contentWidth={splitContentLeft}
								bodyLines={waterfallBodyLines}
								selectedSpanIndex={selectedSpanIndex}
								collapsedSpanIds={collapsedSpanIds}
								onSelectSpan={onSelectSpan}
							/>
						</box>
						<SeparatorColumn height={waterfallBodyLines} />
						<box width={splitRightWidth} flexDirection="column" paddingLeft={1} paddingRight={1}>
							{detailView === "span-detail" ? (
								<SpanDetailView span={selectedSpan} logs={selectedSpanLogs} contentWidth={splitContentRight} bodyLines={waterfallBodyLines} />
							) : (
								<SpanPreview span={selectedSpan} logs={selectedSpanLogs} contentWidth={splitContentRight} maxLines={waterfallBodyLines} />
							)}
						</box>
					</box>
				) : (
					<>
						<box flexDirection="column" paddingLeft={1} paddingRight={1}>
							<WaterfallTimeline
								trace={trace}
								filteredSpans={filteredSpans}
								spanLogCounts={spanLogCounts}
								selectedSpanLogs={selectedSpanLogs}
								contentWidth={contentWidth}
								bodyLines={waterfallBodyLines}
								selectedSpanIndex={selectedSpanIndex}
								collapsedSpanIds={collapsedSpanIds}
								onSelectSpan={onSelectSpan}
							/>
						</box>
						{selectedSpan ? (
							<>
								<Divider width={paneWidth} />
								<box flexDirection="column" paddingLeft={1} paddingRight={1}>
									<SpanPreview span={selectedSpan} logs={selectedSpanLogs} contentWidth={contentWidth} maxLines={previewMaxLines} />
								</box>
							</>
						) : null}
					</>
				)}
			</>
		) : (
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<PlainLine text="No trace selected. Use j/k in the trace list." fg={colors.muted} />
				</box>
			)}
		</box>
	)
}
