import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useAtom } from "@effect/atom-react"
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { config } from "./config.js"
import type { LogItem, TraceItem } from "./domain.ts"
import { fitCell, formatShortDate, formatTimestamp, traceRowId } from "./ui/format.ts"
import { AlignedHeaderLine, BlankRow, Divider, FilterBar, FooterHints, HelpModal, PlainLine, SeparatorColumn, SplitDivider, TextLine } from "./ui/primitives.tsx"
import { ServiceLogsView } from "./ui/ServiceLogs.tsx"
import {
	autoRefreshAtom,
	collapsedSpanIdsAtom,
	detailViewAtom,
	filterModeAtom,
	filterTextAtom,
	initialTraceDetailState,
	traceSortAtom,
	initialLogState,
	initialServiceLogState,
	loadRecentTraceSummaries,
	loadTraceDetail,
	loadServiceLogs,
	loadTraceLogs,
	loadTraceServices,
	logStateAtom,
	noticeAtom,
	persistSelectedService,
	refreshNonceAtom,
	selectedServiceLogIndexAtom,
	selectedSpanIndexAtom,
	selectedTraceIndexAtom,
	selectedTraceServiceAtom,
	serviceLogStateAtom,
	showHelpAtom,
	traceDetailStateAtom,
	traceStateAtom,
} from "./ui/state.ts"
import { SpanDetailPane } from "./ui/SpanDetailPane.tsx"
import { colors, SEPARATOR } from "./ui/theme.ts"
import { TraceDetailsPane } from "./ui/TraceDetailsPane.tsx"
import { getVisibleSpans } from "./ui/Waterfall.tsx"
import { TraceList } from "./ui/TraceList.tsx"
import { useKeyboardNav } from "./ui/useKeyboardNav.ts"

export const App = () => {
	const { width, height } = useTerminalDimensions()
	const [traceState, setTraceState] = useAtom(traceStateAtom)
	const [traceDetailState, setTraceDetailState] = useAtom(traceDetailStateAtom)
	const [logState, setLogState] = useAtom(logStateAtom)
	const [serviceLogState, setServiceLogState] = useAtom(serviceLogStateAtom)
	const [selectedServiceLogIndex, setSelectedServiceLogIndex] = useAtom(selectedServiceLogIndexAtom)
	const [selectedTraceIndex, setSelectedTraceIndex] = useAtom(selectedTraceIndexAtom)
	const [selectedTraceService, setSelectedTraceService] = useAtom(selectedTraceServiceAtom)
	const [refreshNonce, setRefreshNonce] = useAtom(refreshNonceAtom)
	const [notice, setNotice] = useAtom(noticeAtom)
	const [selectedSpanIndex, setSelectedSpanIndex] = useAtom(selectedSpanIndexAtom)
	const [detailView, setDetailView] = useAtom(detailViewAtom)
	const [showHelp, setShowHelp] = useAtom(showHelpAtom)
	const [collapsedSpanIds, setCollapsedSpanIds] = useAtom(collapsedSpanIdsAtom)
	const [autoRefresh] = useAtom(autoRefreshAtom)
	const [filterMode] = useAtom(filterModeAtom)
	const [filterText] = useAtom(filterTextAtom)
	const [traceSort] = useAtom(traceSortAtom)

	// Layout calculations
	const contentWidth = Math.max(60, width ?? 100)
	// Lazygit-style: side-by-side for anything remotely wide; vertical stack only
	// when the terminal is truly narrow.
	const isWideLayout = (width ?? 100) >= 100
	const splitGap = 1
	const sectionPadding = 1
	const traceListHeaderHeight = 1
	const footerNotice = notice ? fitCell(notice, Math.max(24, Math.max(60, width ?? 100) - 2)) : null
	const footerHeight = 1
	const footerFrameHeight = footerHeight > 0 ? 1 + footerHeight : 0
	const frameHeight = 1 + 1 + footerFrameHeight
	const availableContentHeight = Math.max(10, (height ?? 24) - frameHeight)
	// Level 2 (span detail focused) rebalances the split so the waterfall
	// context on the left has more room to breathe — otherwise the bars and
	// labels get aggressively truncated in the narrow 40% slice.
	const viewLevelForLayout: 0 | 1 | 2 =
		detailView === "span-detail" ? 2 :
		selectedSpanIndex !== null ? 1 :
		0
	const splitRatio = viewLevelForLayout === 2 ? 0.5 : 0.4
	const leftPaneWidth = isWideLayout ? Math.max(40, Math.floor((contentWidth - splitGap) * splitRatio)) : contentWidth
	const rightPaneWidth = isWideLayout ? Math.max(28, contentWidth - leftPaneWidth - splitGap) : contentWidth

	const leftContentWidth = isWideLayout ? Math.max(24, leftPaneWidth - 3) : Math.max(24, contentWidth - sectionPadding * 2)
	const rightContentWidth = isWideLayout ? Math.max(24, rightPaneWidth - sectionPadding * 2) : Math.max(24, contentWidth - sectionPadding * 2)
	const headerFooterWidth = Math.max(24, contentWidth - 2)
	const wideBodyHeight = availableContentHeight
	const wideBodyLines = Math.max(8, wideBodyHeight - 5)
	// Narrow: each drill-in level gets the full body (minus a 1-line breadcrumb
	// on L1/L2). At L0 we keep today's stacked list + details layout.
	const narrowSplitHeight = Math.max(10, availableContentHeight - 1)
	const narrowListHeight = Math.max(4, Math.min(10, Math.floor(narrowSplitHeight * 0.4), narrowSplitHeight - 9))
	const narrowDetailHeight = narrowSplitHeight - narrowListHeight
	const narrowBodyLines = Math.max(2, narrowDetailHeight - 5)
	const narrowFullBodyLines = Math.max(8, availableContentHeight - 6) // header(1) + breadcrumb(1) + divider(1) + details header(4) + footer divider
	const wideTraceListBodyHeight = Math.max(1, wideBodyHeight - traceListHeaderHeight)
	const narrowTraceListBodyHeight = Math.max(1, narrowListHeight - traceListHeaderHeight)
	const traceViewportRows = isWideLayout ? wideTraceListBodyHeight : narrowTraceListBodyHeight
	const tracePageSize = Math.max(1, traceViewportRows - 1)
	const spanViewportRows = Math.max(1, (isWideLayout ? wideBodyLines : narrowBodyLines) - 1)
	const spanPageSize = Math.max(1, spanViewportRows - 1)

	// Refs
	const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const traceListScrollRef = useRef<ScrollBoxRenderable | null>(null)
	const selectedTraceRef = useRef<string | null>(null)
	const cacheEpochRef = useRef(0)
	const traceDetailCacheRef = useRef(new Map<string, { data: TraceItem | null; fetchedAt: Date }>())
	const traceLogCacheRef = useRef(new Map<string, { data: readonly LogItem[]; fetchedAt: Date }>())
	const serviceLogCacheRef = useRef(new Map<string, { data: readonly LogItem[]; fetchedAt: Date }>())
	const traceDetailInflightRef = useRef(new Map<string, Promise<{ readonly error: string | null }>>())
	const traceLogInflightRef = useRef(new Map<string, Promise<{ readonly error: string | null }>>())

	const flashNotice = (message: string) => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}
		setNotice(message)
		noticeTimeoutRef.current = globalThis.setTimeout(() => {
			setNotice((current) => (current === message ? null : current))
		}, 2500)
	}

	// Cleanup timeouts
	useEffect(() => () => {
		if (noticeTimeoutRef.current !== null) {
			clearTimeout(noticeTimeoutRef.current)
		}
	}, [])

	useEffect(() => {
		if (selectedTraceService) persistSelectedService(selectedTraceService)
	}, [selectedTraceService])

	// Auto-refresh every 5 seconds
	useEffect(() => {
		if (!autoRefresh) return
		const id = setInterval(() => setRefreshNonce((n) => n + 1), 5000)
		return () => clearInterval(id)
	}, [autoRefresh])

	useEffect(() => {
		cacheEpochRef.current += 1
		traceDetailCacheRef.current.clear()
		traceLogCacheRef.current.clear()
		serviceLogCacheRef.current.clear()
		traceDetailInflightRef.current.clear()
		traceLogInflightRef.current.clear()
	}, [refreshNonce])

	// Load traces
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

				const traces = effectiveService ? await loadRecentTraceSummaries(effectiveService) : []
				if (cancelled) return

				// Preserve selection by trace ID across refreshes
				const prevTraceId = selectedTraceRef.current
				setTraceState({
					status: "ready",
					services,
					data: traces,
					error: null,
					fetchedAt: new Date(),
				})
				if (prevTraceId) {
					const newIndex = traces.findIndex((t) => t.traceId === prevTraceId)
					if (newIndex >= 0) setSelectedTraceIndex(newIndex)
				}
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

	// Clamp trace index
	useEffect(() => {
		setSelectedTraceIndex((current) => {
			if (traceState.data.length === 0) return 0
			return Math.max(0, Math.min(current, traceState.data.length - 1))
		})
	}, [traceState.data.length])

	const selectedTraceSummary = traceState.data[selectedTraceIndex] ?? null
	const selectedTraceId = selectedTraceSummary?.traceId ?? null
	const selectedTrace = traceDetailState.traceId === selectedTraceId ? traceDetailState.data : null
	selectedTraceRef.current = selectedTraceId

	const warmTraceDetail = useCallback((traceId: string, hydrateSelection: boolean) => {
		const cached = traceDetailCacheRef.current.get(traceId)
		if (cached) {
			if (hydrateSelection && selectedTraceRef.current === traceId) {
				setTraceDetailState({
					status: "ready",
					traceId,
					data: cached.data,
					error: null,
					fetchedAt: cached.fetchedAt,
				})
			}
			return Promise.resolve({ error: null })
		}

		const existing = traceDetailInflightRef.current.get(traceId)
		if (existing) {
			if (hydrateSelection) {
				void existing.then(({ error }) => {
					if (selectedTraceRef.current !== traceId) return
					const ready = traceDetailCacheRef.current.get(traceId)
					if (ready) {
						setTraceDetailState({ status: "ready", traceId, data: ready.data, error: null, fetchedAt: ready.fetchedAt })
						return
					}
					if (error) {
						setTraceDetailState({ status: "error", traceId, data: null, error, fetchedAt: null })
					}
				})
			}
			return existing
		}

		const epoch = cacheEpochRef.current
		const request = loadTraceDetail(traceId)
			.then((trace) => {
				if (cacheEpochRef.current !== epoch) return { error: null }
				const fetchedAt = new Date()
				traceDetailCacheRef.current.set(traceId, { data: trace, fetchedAt })
				if (hydrateSelection && selectedTraceRef.current === traceId) {
					setTraceDetailState({ status: "ready", traceId, data: trace, error: null, fetchedAt })
				}
				return { error: null }
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error)
				if (cacheEpochRef.current === epoch && hydrateSelection && selectedTraceRef.current === traceId) {
					setTraceDetailState({ status: "error", traceId, data: null, error: message, fetchedAt: null })
				}
				return { error: message }
			})
			.finally(() => {
				traceDetailInflightRef.current.delete(traceId)
			})

		traceDetailInflightRef.current.set(traceId, request)
		return request
	}, [setTraceDetailState])

	const warmTraceLogs = useCallback((traceId: string, hydrateSelection: boolean) => {
		const cached = traceLogCacheRef.current.get(traceId)
		if (cached) {
			if (hydrateSelection && selectedTraceRef.current === traceId) {
				setLogState({ status: "ready", traceId, data: cached.data, error: null, fetchedAt: cached.fetchedAt })
			}
			return Promise.resolve({ error: null })
		}

		const existing = traceLogInflightRef.current.get(traceId)
		if (existing) {
			if (hydrateSelection) {
				void existing.then(({ error }) => {
					if (selectedTraceRef.current !== traceId) return
					const ready = traceLogCacheRef.current.get(traceId)
					if (ready) {
						setLogState({ status: "ready", traceId, data: ready.data, error: null, fetchedAt: ready.fetchedAt })
						return
					}
					if (error) {
						setLogState({ status: "error", traceId, data: [], error, fetchedAt: null })
					}
				})
			}
			return existing
		}

		const epoch = cacheEpochRef.current
		const request = loadTraceLogs(traceId)
			.then((logs) => {
				if (cacheEpochRef.current !== epoch) return { error: null }
				const fetchedAt = new Date()
				traceLogCacheRef.current.set(traceId, { data: logs, fetchedAt })
				if (hydrateSelection && selectedTraceRef.current === traceId) {
					setLogState({ status: "ready", traceId, data: logs, error: null, fetchedAt })
				}
				return { error: null }
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error)
				if (cacheEpochRef.current === epoch && hydrateSelection && selectedTraceRef.current === traceId) {
					setLogState({ status: "error", traceId, data: [], error: message, fetchedAt: null })
				}
				return { error: message }
			})
			.finally(() => {
				traceLogInflightRef.current.delete(traceId)
			})

		traceLogInflightRef.current.set(traceId, request)
		return request
	}, [setLogState])

	useEffect(() => {
		if (!selectedTraceId) {
			setTraceDetailState(initialTraceDetailState)
			return
		}

		const cached = traceDetailCacheRef.current.get(selectedTraceId)
		if (cached) {
			setTraceDetailState({
				status: "ready",
				traceId: selectedTraceId,
				data: cached.data,
				error: null,
				fetchedAt: cached.fetchedAt,
			})
			return
		}

		setTraceDetailState((current) => ({
			status: current.traceId === selectedTraceId && current.fetchedAt !== null ? "ready" : "loading",
			traceId: selectedTraceId,
			data: current.traceId === selectedTraceId ? current.data : null,
			error: null,
			fetchedAt: current.traceId === selectedTraceId ? current.fetchedAt : null,
		}))

		void warmTraceDetail(selectedTraceId, true)
	}, [refreshNonce, selectedTraceId, setTraceDetailState, warmTraceDetail])

	// Reset collapsed spans and span selection when trace changes
	useEffect(() => {
		setCollapsedSpanIds(new Set())
		setSelectedSpanIndex(null)
	}, [selectedTraceId])

	// Clamp span index against visible (filtered) span count
	useEffect(() => {
		if (selectedSpanIndex === null) return
		if (!selectedTrace || selectedTrace.spans.length === 0) {
			setSelectedSpanIndex(null)
			setDetailView("waterfall")
			return
		}
		const visibleCount = getVisibleSpans(selectedTrace.spans, collapsedSpanIds).length
		if (selectedSpanIndex >= visibleCount) {
			setSelectedSpanIndex(visibleCount - 1)
		}
	}, [selectedTrace, selectedSpanIndex, collapsedSpanIds, setSelectedSpanIndex, setDetailView])

	// Scroll selected trace into view (use summary ID, not detail which loads async)
	useLayoutEffect(() => {
		const traceId = selectedTraceSummary?.traceId
		if (!traceId) return
		traceListScrollRef.current?.scrollChildIntoView(traceRowId(traceId))
	}, [selectedTraceIndex, selectedTraceSummary?.traceId, filterText])

	// Load trace logs
	useEffect(() => {
		const traceId = selectedTraceId
		if (!traceId) {
			setLogState(initialLogState)
			return
		}

		const cached = traceLogCacheRef.current.get(traceId)
		if (cached) {
			setLogState({ status: "ready", traceId, data: cached.data, error: null, fetchedAt: cached.fetchedAt })
			return
		}

		setLogState((current) => ({
			status: current.traceId === traceId && current.fetchedAt !== null ? "ready" : "loading",
			traceId,
			data: current.traceId === traceId ? current.data : [],
			error: null,
			fetchedAt: current.traceId === traceId ? current.fetchedAt : null,
		}))

		void warmTraceLogs(traceId, true)
	}, [refreshNonce, selectedTraceId, setLogState, warmTraceLogs])

	// Load service logs
	useEffect(() => {
		if (detailView !== "service-logs") return

		const serviceName = selectedTraceService
		if (!serviceName) {
			setServiceLogState(initialServiceLogState)
			return
		}

		const cached = serviceLogCacheRef.current.get(serviceName)
		if (cached) {
			setServiceLogState({ status: "ready", serviceName, data: cached.data, error: null, fetchedAt: cached.fetchedAt })
			return
		}

		let cancelled = false

		setServiceLogState((current) => ({
			status: current.serviceName === serviceName && current.fetchedAt !== null ? "ready" : "loading",
			serviceName,
			data: current.serviceName === serviceName ? current.data : [],
			error: null,
			fetchedAt: current.serviceName === serviceName ? current.fetchedAt : null,
		}))

		void (async () => {
			try {
				const logs = await loadServiceLogs(serviceName)
				const fetchedAt = new Date()
				serviceLogCacheRef.current.set(serviceName, { data: logs, fetchedAt })
				if (cancelled) return
				setServiceLogState({ status: "ready", serviceName, data: logs, error: null, fetchedAt })
			} catch (error) {
				if (cancelled) return
				setServiceLogState({ status: "error", serviceName, data: [], error: error instanceof Error ? error.message : String(error), fetchedAt: null })
			}
		})()

		return () => { cancelled = true }
	}, [detailView, refreshNonce, selectedTraceService, setServiceLogState])

	// Clamp service log index
	useEffect(() => {
		setSelectedServiceLogIndex((current) => {
			if (serviceLogState.data.length === 0) return 0
			return Math.max(0, Math.min(current, serviceLogState.data.length - 1))
		})
	}, [serviceLogState.data.length, setSelectedServiceLogIndex])

	// Apply trace filter
	const preFilterTraces = filterText
		? traceState.data.filter((trace) => {
			const needle = filterText.toLowerCase()
			const errorOnly = needle.includes(":error")
			const textNeedle = needle.replace(":error", "").trim()
			if (errorOnly && trace.errorCount === 0) return false
			if (textNeedle && !trace.rootOperationName.toLowerCase().includes(textNeedle)) return false
			return true
		})
		: traceState.data

	// Apply sort (default is recent, which is the server's order)
	const filteredTraces = traceSort === "recent"
		? preFilterTraces
		: [...preFilterTraces].sort((a, b) => {
			if (traceSort === "slowest") return b.durationMs - a.durationMs
			if (traceSort === "errors") return b.errorCount - a.errorCount || b.startedAt.getTime() - a.startedAt.getTime()
			return 0
		})

	useEffect(() => {
		if (!selectedTraceId || filteredTraces.length === 0) return
		const currentIndex = filteredTraces.findIndex((trace) => trace.traceId === selectedTraceId)
		if (currentIndex < 0) return

		for (const offset of [-1, 1] as const) {
			const neighborId = filteredTraces[currentIndex + offset]?.traceId
			if (!neighborId) continue
			void warmTraceDetail(neighborId, false)
			void warmTraceLogs(neighborId, false)
		}
	}, [filteredTraces, selectedTraceId, warmTraceDetail, warmTraceLogs])

	// Keyboard navigation
	const { spanNavActive } = useKeyboardNav({
		selectedTrace,
		filteredTraces,
		isWideLayout,
		wideBodyLines,
		narrowBodyLines,
		tracePageSize,
		spanPageSize,
		flashNotice,
	})

	// Header
	const autoLabel = autoRefresh ? "\u25cf live" : "\u25cb paused"
	const headerServiceLabel = selectedTraceService ?? "none"
	const headerRight = traceState.fetchedAt
		? `${autoLabel}  ${formatTimestamp(traceState.fetchedAt)}`
		: traceState.status === "loading"
			? "loading traces..."
			: ""
	// Rendered text is "MOTEL" + " · " (3 chars) + <service>
	const headerLeftLen = "MOTEL".length + 3 + headerServiceLabel.length
	const headerGap = Math.max(2, headerFooterWidth - headerLeftLen - headerRight.length)
	const visibleFooterNotice = footerNotice ? fitCell(footerNotice.trimEnd(), headerFooterWidth) : null

	const selectTraceById = useCallback((traceId: string) => {
		const index = traceState.data.findIndex((trace) => trace.traceId === traceId)
		if (index >= 0) setSelectedTraceIndex(index)
	}, [traceState.data, setSelectedTraceIndex])

	const selectSpan = useCallback((index: number) => {
		if (!selectedTrace) return
		const visibleCount = getVisibleSpans(selectedTrace.spans, collapsedSpanIds).length
		setSelectedSpanIndex(Math.max(0, Math.min(index, visibleCount - 1)))
	}, [selectedTrace, collapsedSpanIds, setSelectedSpanIndex])

	const traceListProps = useMemo(() => ({
		traces: filteredTraces,
		selectedTraceId,
		status: traceState.status,
		error: traceState.error,
		contentWidth: leftContentWidth,
		services: traceState.services,
		selectedService: selectedTraceService,
		focused: !spanNavActive,
		filterText: filterText || undefined,
		sortMode: traceSort,
		totalCount: filterText ? traceState.data.length : undefined,
		onSelectTrace: selectTraceById,
	} as const), [filteredTraces, selectedTraceId, traceState.status, traceState.error, leftContentWidth, traceState.services, selectedTraceService, spanNavActive, filterText, traceSort, traceState.data.length, selectTraceById])

	// Drill-in state machine:
	//   level 0: trace list focused
	//   level 1: span nav (waterfall focused)
	//   level 2: span detail focused
	const viewLevel = viewLevelForLayout
	const filteredSpansApp = selectedTrace ? getVisibleSpans(selectedTrace.spans, collapsedSpanIds) : []
	const selectedSpan = selectedSpanIndex !== null ? filteredSpansApp[selectedSpanIndex] ?? null : null
	const selectedSpanLogs = useMemo(
		() => selectedSpan ? logState.data.filter((log) => log.spanId === selectedSpan.spanId) : [],
		[selectedSpan, logState.data],
	)

	// Wide layout: whether to show a split separator between the two panes.
	const showSplit = isWideLayout

	// Row within each pane where the internal divider sits. Both TraceDetailsPane
	// and SpanDetailPane header is: 1 (title) + 2 (info) + 1 (divider) = 4 rows
	// → junction on row 3.
	//
	// At L0/L1 the left pane is the TraceList (no internal divider at row 3),
	// so the separator only needs to connect to the right pane (`├`). At L2
	// both panes have a divider at row 3, so we need a full cross (`┼`).
	const separatorJunctionChars = useMemo(() => {
		const m = new Map<number, string>()
		m.set(3, viewLevel === 2 ? "\u253c" : "\u251c")
		return m
	}, [viewLevel])

	return (
		<box flexGrow={1} flexDirection="column">
			<box paddingLeft={1} paddingRight={1} flexDirection="column">
			<TextLine>
				<span fg={colors.muted} attributes={TextAttributes.BOLD}>MOTEL</span>
				<span fg={colors.separator}>{" · "}</span>
				<span fg={colors.muted}>{headerServiceLabel}</span>
				<span fg={colors.muted}>{" ".repeat(headerGap)}</span>
				<span fg={colors.muted} attributes={TextAttributes.BOLD}>{headerRight}</span>
			</TextLine>
			</box>
			{showSplit
				? <SplitDivider leftWidth={leftPaneWidth} junction={"\u252c"} rightWidth={rightPaneWidth} />
				: <Divider width={contentWidth} />}
			{detailView === "service-logs" ? (
				<box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
					<AlignedHeaderLine
						left="SERVICE LOGS"
						right={`${serviceLogState.data.length} logs${serviceLogState.fetchedAt ? `${SEPARATOR}${formatShortDate(serviceLogState.fetchedAt)} ${formatTimestamp(serviceLogState.fetchedAt)}` : ""}`}
						width={headerFooterWidth}
						rightFg={colors.count}
					/>
					<TextLine>
						<span fg={colors.defaultService}>{selectedTraceService ?? "unknown"}</span>
						<span fg={colors.separator}>{SEPARATOR}</span>
						<span fg={colors.count}>recent logs</span>
					</TextLine>
					<BlankRow />
					<ServiceLogsView
						serviceName={selectedTraceService}
						logsState={serviceLogState}
						selectedIndex={selectedServiceLogIndex}
						onSelectLog={setSelectedServiceLogIndex}
						contentWidth={headerFooterWidth}
						bodyLines={Math.max(8, availableContentHeight - 3)}
					/>
				</box>
			) : isWideLayout ? (
				/* WIDE LAYOUT. Drill-in slides right:
				 *   L0: [list focused]  | [waterfall preview]
				 *   L1: [list context]  | [waterfall focused]
				 *   L2: [waterfall ctx] | [span-detail focused]
				 */
				<box flexGrow={1} flexDirection="row">
					<box width={leftPaneWidth} height={wideBodyHeight} flexDirection="column" paddingLeft={sectionPadding} paddingRight={sectionPadding}>
						{viewLevel <= 1 ? (
							<>
								<TraceList showHeader {...traceListProps} />
								{filterMode ? <FilterBar text={filterText} width={leftContentWidth} /> : null}
								<scrollbox ref={traceListScrollRef} height={filterMode ? wideTraceListBodyHeight - 1 : wideTraceListBodyHeight} flexGrow={0}>
									<TraceList showHeader={false} {...traceListProps} />
								</scrollbox>
							</>
						) : (
							<TraceDetailsPane
								trace={selectedTrace}
								traceSummary={selectedTraceSummary}
								traceStatus={traceDetailState.status}
								traceError={traceDetailState.error}
								traceLogsState={logState}
								contentWidth={leftContentWidth}
								bodyLines={wideBodyLines}
								paneWidth={leftPaneWidth}
								selectedSpanIndex={selectedSpanIndex}
								collapsedSpanIds={collapsedSpanIds}
								focused={false}
								onSelectSpan={selectSpan}
							/>
						)}
					</box>
					<SeparatorColumn height={wideBodyHeight} junctionChars={separatorJunctionChars} />
					<box width={rightPaneWidth} height={wideBodyHeight} flexDirection="column">
						{viewLevel <= 1 ? (
							<TraceDetailsPane
								trace={selectedTrace}
								traceSummary={selectedTraceSummary}
								traceStatus={traceDetailState.status}
								traceError={traceDetailState.error}
								traceLogsState={logState}
								contentWidth={rightContentWidth}
								bodyLines={wideBodyLines}
								paneWidth={rightPaneWidth}
								selectedSpanIndex={selectedSpanIndex}
								collapsedSpanIds={collapsedSpanIds}
								focused={viewLevel === 1}
								onSelectSpan={selectSpan}
							/>
						) : (
							<SpanDetailPane
								span={selectedSpan}
								trace={selectedTrace}
								logs={selectedSpanLogs}
								contentWidth={rightContentWidth}
								bodyLines={wideBodyLines}
								paneWidth={rightPaneWidth}
								focused={true}
							/>
						)}
					</box>
				</box>
			) : viewLevel === 0 ? (
				/* NARROW L0: list on top, trace details below. */
				<>
					<box height={narrowListHeight} flexDirection="column" paddingLeft={sectionPadding} paddingRight={sectionPadding}>
						<TraceList showHeader {...traceListProps} />
						{filterMode ? <FilterBar text={filterText} width={leftContentWidth} /> : null}
						<scrollbox ref={traceListScrollRef} height={filterMode ? narrowTraceListBodyHeight - 1 : narrowTraceListBodyHeight} flexGrow={0}>
							<TraceList showHeader={false} {...traceListProps} />
						</scrollbox>
					</box>
					<Divider width={contentWidth} />
					<TraceDetailsPane
						trace={selectedTrace}
						traceSummary={selectedTraceSummary}
						traceStatus={traceDetailState.status}
						traceError={traceDetailState.error}
						traceLogsState={logState}
						contentWidth={rightContentWidth}
						bodyLines={narrowBodyLines}
						paneWidth={contentWidth}
						selectedSpanIndex={selectedSpanIndex}
						collapsedSpanIds={collapsedSpanIds}
						focused={false}
						onSelectSpan={selectSpan}
					/>
				</>
			) : (
				/* NARROW L1/L2: 1-line breadcrumb + full-body pane. */
				<>
					<box paddingLeft={1} paddingRight={1} height={1} flexDirection="column">
						<TextLine>
							<span fg={colors.muted}>TRACES</span>
							{selectedTraceSummary ? (
								<>
									<span fg={colors.separator}>{"  "}{SEPARATOR}{"  "}</span>
									<span fg={viewLevel === 1 ? colors.accent : colors.muted}>{selectedTraceSummary.rootOperationName}</span>
								</>
							) : null}
							{viewLevel === 2 && selectedSpan ? (
								<>
									<span fg={colors.separator}>{"  "}{SEPARATOR}{"  "}</span>
									<span fg={colors.accent}>{selectedSpan.operationName}</span>
								</>
							) : null}
						</TextLine>
					</box>
					<Divider width={contentWidth} />
					{viewLevel === 1 ? (
						<TraceDetailsPane
							trace={selectedTrace}
							traceSummary={selectedTraceSummary}
							traceStatus={traceDetailState.status}
							traceError={traceDetailState.error}
							traceLogsState={logState}
							contentWidth={rightContentWidth}
							bodyLines={narrowFullBodyLines}
							paneWidth={contentWidth}
							selectedSpanIndex={selectedSpanIndex}
							collapsedSpanIds={collapsedSpanIds}
							focused={true}
							onSelectSpan={selectSpan}
						/>
					) : (
						<SpanDetailPane
							span={selectedSpan}
							trace={selectedTrace}
							logs={selectedSpanLogs}
							contentWidth={rightContentWidth}
							bodyLines={narrowFullBodyLines}
							paneWidth={contentWidth}
							focused={true}
						/>
					)}
				</>
			)}
			{footerHeight > 0 ? (
				<>
					{showSplit
						? <SplitDivider leftWidth={leftPaneWidth} junction={"\u2534"} rightWidth={rightPaneWidth} />
						: <Divider width={contentWidth} />}
					<box paddingLeft={1} paddingRight={1} flexDirection="column" height={footerHeight}>
						{visibleFooterNotice ? (
							<PlainLine text={visibleFooterNotice} fg={colors.count} />
						) : (
							<FooterHints spanNavActive={spanNavActive} detailView={detailView} autoRefresh={autoRefresh} width={headerFooterWidth} />
						)}
					</box>
				</>
			) : null}
			{showHelp ? <HelpModal width={width ?? 100} height={height ?? 24} autoRefresh={autoRefresh} onClose={() => setShowHelp(false)} /> : null}
		</box>
	)
}
