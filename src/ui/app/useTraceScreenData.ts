import { useAtom } from "@effect/atom-react"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { config } from "../../config.js"
import type { LogItem, TraceItem } from "../../domain.ts"
import {
	autoRefreshAtom,
	collapsedSpanIdsAtom,
	detailViewAtom,
	filterModeAtom,
	filterTextAtom,
	initialLogState,
	initialServiceLogState,
	initialTraceDetailState,
	loadRecentTraceSummaries,
	loadServiceLogs,
	loadTraceDetail,
	loadTraceLogs,
	loadTraceServices,
	logStateAtom,
	persistSelectedService,
	refreshNonceAtom,
	selectedServiceLogIndexAtom,
	selectedSpanIndexAtom,
	selectedTraceIndexAtom,
	selectedTraceServiceAtom,
	serviceLogStateAtom,
	showHelpAtom,
	traceDetailStateAtom,
	traceSortAtom,
	traceStateAtom,
} from "../state.ts"
import { getVisibleSpans } from "../Waterfall.tsx"

export const useTraceScreenData = () => {
	const [traceState, setTraceState] = useAtom(traceStateAtom)
	const [traceDetailState, setTraceDetailState] = useAtom(traceDetailStateAtom)
	const [logState, setLogState] = useAtom(logStateAtom)
	const [serviceLogState, setServiceLogState] = useAtom(serviceLogStateAtom)
	const [selectedServiceLogIndex, setSelectedServiceLogIndex] = useAtom(selectedServiceLogIndexAtom)
	const [selectedTraceIndex, setSelectedTraceIndex] = useAtom(selectedTraceIndexAtom)
	const [selectedTraceService, setSelectedTraceService] = useAtom(selectedTraceServiceAtom)
	const [refreshNonce, setRefreshNonce] = useAtom(refreshNonceAtom)
	const [selectedSpanIndex, setSelectedSpanIndex] = useAtom(selectedSpanIndexAtom)
	const [detailView, setDetailView] = useAtom(detailViewAtom)
	const [showHelp, setShowHelp] = useAtom(showHelpAtom)
	const [collapsedSpanIds, setCollapsedSpanIds] = useAtom(collapsedSpanIdsAtom)
	const [autoRefresh] = useAtom(autoRefreshAtom)
	const [filterMode] = useAtom(filterModeAtom)
	const [filterText] = useAtom(filterTextAtom)
	const [traceSort] = useAtom(traceSortAtom)

	const selectedTraceRef = useRef<string | null>(null)
	const cacheEpochRef = useRef(0)
	const traceDetailCacheRef = useRef(new Map<string, { data: TraceItem | null; fetchedAt: Date }>())
	const traceLogCacheRef = useRef(new Map<string, { data: readonly LogItem[]; fetchedAt: Date }>())
	const serviceLogCacheRef = useRef(new Map<string, { data: readonly LogItem[]; fetchedAt: Date }>())
	const traceDetailInflightRef = useRef(new Map<string, Promise<{ readonly error: string | null }>>())
	const traceLogInflightRef = useRef(new Map<string, Promise<{ readonly error: string | null }>>())

	useEffect(() => {
		if (selectedTraceService) persistSelectedService(selectedTraceService)
	}, [selectedTraceService])

	useEffect(() => {
		if (!autoRefresh) return
		const id = setInterval(() => setRefreshNonce((n) => n + 1), 5000)
		return () => clearInterval(id)
	}, [autoRefresh, setRefreshNonce])

	useEffect(() => {
		cacheEpochRef.current += 1
		traceDetailCacheRef.current.clear()
		traceLogCacheRef.current.clear()
		serviceLogCacheRef.current.clear()
		traceDetailInflightRef.current.clear()
		traceLogInflightRef.current.clear()
	}, [refreshNonce])

	useEffect(() => {
		let cancelled = false

		const load = async () => {
			setTraceState((current) => ({ ...current, status: current.fetchedAt === null ? "loading" : "ready", error: null }))

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

				const prevTraceId = selectedTraceRef.current
				setTraceState({ status: "ready", services, data: traces, error: null, fetchedAt: new Date() })
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
	}, [refreshNonce, selectedTraceService, setSelectedTraceIndex, setSelectedTraceService, setTraceState])

	useEffect(() => {
		setSelectedTraceIndex((current) => {
			if (traceState.data.length === 0) return 0
			return Math.max(0, Math.min(current, traceState.data.length - 1))
		})
	}, [traceState.data.length, setSelectedTraceIndex])

	const selectedTraceSummary = traceState.data[selectedTraceIndex] ?? null
	const selectedTraceId = selectedTraceSummary?.traceId ?? null
	const selectedTrace = traceDetailState.traceId === selectedTraceId ? traceDetailState.data : null
	selectedTraceRef.current = selectedTraceId

	const warmTraceDetail = useCallback((traceId: string, hydrateSelection: boolean) => {
		const cached = traceDetailCacheRef.current.get(traceId)
		if (cached) {
			if (hydrateSelection && selectedTraceRef.current === traceId) {
				setTraceDetailState({ status: "ready", traceId, data: cached.data, error: null, fetchedAt: cached.fetchedAt })
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
			setTraceDetailState({ status: "ready", traceId: selectedTraceId, data: cached.data, error: null, fetchedAt: cached.fetchedAt })
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

	useEffect(() => {
		setCollapsedSpanIds(new Set())
		setSelectedSpanIndex(null)
	}, [selectedTraceId, setCollapsedSpanIds, setSelectedSpanIndex])

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
	}, [selectedTrace, selectedSpanIndex, collapsedSpanIds, setDetailView, setSelectedSpanIndex])

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

		return () => {
			cancelled = true
		}
	}, [detailView, refreshNonce, selectedTraceService, setServiceLogState])

	useEffect(() => {
		setSelectedServiceLogIndex((current) => {
			if (serviceLogState.data.length === 0) return 0
			return Math.max(0, Math.min(current, serviceLogState.data.length - 1))
		})
	}, [serviceLogState.data.length, setSelectedServiceLogIndex])

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

	return {
		traceState,
		traceDetailState,
		logState,
		serviceLogState,
		selectedServiceLogIndex,
		setSelectedServiceLogIndex,
		selectedTraceIndex,
		setSelectedTraceIndex,
		selectedTraceService,
		selectedSpanIndex,
		setSelectedSpanIndex,
		detailView,
		setDetailView,
		showHelp,
		setShowHelp,
		collapsedSpanIds,
		autoRefresh,
		filterMode,
		filterText,
		traceSort,
		selectedTraceSummary,
		selectedTrace,
		selectedTraceId,
		filteredTraces,
	} as const
}
