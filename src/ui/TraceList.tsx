import { TextAttributes } from "@opentui/core"
import { memo } from "react"
import { config } from "../config.ts"
import type { TraceSummaryItem } from "../domain.ts"
import { fitCell, formatDuration, lifecycleLabel, relativeTime, traceIndicator, traceIndicatorColor, traceRowId } from "./format.ts"
import { PlainLine, TextLine } from "./primitives.tsx"
import type { LoadStatus } from "./state.ts"
import { colors } from "./theme.ts"

const getTraceRowLayout = (contentWidth: number) => {
	const stateWidth = 1
	const durationWidth = 8
	const countWidth = 7
	const ageWidth = 6
	// gaps: 1 after state, 1 after duration, 1 after count, plus 2 slack on the right
	const titleWidth = Math.max(8, contentWidth - stateWidth - durationWidth - countWidth - ageWidth - 5)
	return { stateWidth, durationWidth, countWidth, ageWidth, titleWidth }
}

const TraceRow = ({
	trace,
	selected,
	contentWidth,
	onSelect,
}: {
	trace: TraceSummaryItem
	selected: boolean
	contentWidth: number
	onSelect: () => void
}) => {
	const { stateWidth, durationWidth, countWidth, ageWidth, titleWidth } = getTraceRowLayout(contentWidth)
	const title = trace.isRunning
		? `${trace.rootOperationName} #${trace.traceId.slice(-6)} [${lifecycleLabel(trace)}]`
		: `${trace.rootOperationName} #${trace.traceId.slice(-6)}`
	const titleColor = selected ? colors.selectedText : trace.isRunning ? colors.warning : colors.text

	return (
		<box id={traceRowId(trace.traceId)} height={1} onMouseDown={onSelect}>
			<TextLine fg={selected ? colors.selectedText : colors.text} bg={selected ? colors.selectedBg : undefined}>
				<span fg={traceIndicatorColor(trace)}>{fitCell(traceIndicator(trace), stateWidth)}</span>
				<span> </span>
				<span fg={titleColor}>{fitCell(title, titleWidth)}</span>
				<span fg={selected ? colors.accent : colors.count}>{fitCell(trace.durationMs >= 1 ? formatDuration(trace.durationMs) : "", durationWidth, "right")}</span>
				<span> </span>
				<span fg={colors.muted}>{fitCell(`${trace.spanCount}sp`, countWidth, "right")}</span>
				<span> </span>
				<span fg={colors.muted}>{fitCell(relativeTime(trace.startedAt), ageWidth, "right")}</span>
			</TextLine>
		</box>
	)
}

export const TraceList = ({
	showHeader,
	traces,
	selectedTraceId,
	status,
	error,
	contentWidth,
	services,
	selectedService,
	focused = true,
	filterText,
	sortMode,
	totalCount,
	onSelectTrace,
}: {
	showHeader: boolean
	traces: readonly TraceSummaryItem[]
	selectedTraceId: string | null
	status: LoadStatus
	error: string | null
	contentWidth: number
	services: readonly string[]
	selectedService: string | null
	focused?: boolean
	filterText?: string
	sortMode?: string
	totalCount?: number
	onSelectTrace: (traceId: string) => void
}) => {
	if (showHeader) {
		const countLabel = totalCount !== undefined && totalCount !== traces.length ? `${traces.length}/${totalCount}` : traces.length > 0 ? String(traces.length) : ""
		const metaLabel = [
			filterText ? `filter: ${filterText}` : null,
			sortMode && sortMode !== "recent" ? `sort: ${sortMode}` : null,
		].filter((part): part is string => part !== null).join(" · ")
		const serviceLabel = services.length > 1 && selectedService
			? `${services.length} services`
			: ""
		const leftLabel = `TRACES${countLabel ? ` ${countLabel}` : ""}${metaLabel ? ` · ${metaLabel}` : ""}`
		const gap = Math.max(2, contentWidth - leftLabel.length - serviceLabel.length)
		return (
			<TextLine>
				<span fg={colors.accent} attributes={TextAttributes.BOLD}>TRACES</span>
				{countLabel ? <span fg={colors.muted}>{` ${countLabel}`}</span> : null}
				{metaLabel ? <span fg={colors.muted}>{` · ${metaLabel}`}</span> : null}
				<span fg={colors.muted}>{" ".repeat(gap)}</span>
				<span fg={colors.muted}>{serviceLabel}</span>
			</TextLine>
		)
	}

	return (
		<box flexDirection="column">
			{status === "loading" && traces.length === 0 ? <PlainLine text="Loading traces..." fg={colors.muted} /> : null}
			{status === "error" ? <PlainLine text={error ?? "Could not load traces."} fg={colors.error} /> : null}
			{status === "ready" && services.length === 0 ? <PlainLine text="No services reporting yet. Start your app and emit a span." fg={colors.muted} /> : null}
			{status === "ready" && selectedService && traces.length === 0 ? <PlainLine text="No traces in the current lookback window." fg={colors.muted} /> : null}
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
